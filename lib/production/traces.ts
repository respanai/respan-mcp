// lib/production/traces.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch, requireClient } from "../shared/client.js";
import {
  filterGuardError,
  guardErrorResult,
  toBackendFilters,
  type FilterFieldSpec,
} from "../shared/filter-fields.js";
import {
  INTERNAL_RESPONSE_KEYS,
  READ_ONLY_WORKSPACE_TOOL,
  budgetedJson,
  omitKeys,
  readListPage,
  textResult,
  truncateStrings,
} from "../shared/tool-result.js";
import {
  environmentShape,
  filterConditionSchema,
  pageShape,
  resolvePage,
  resolveTimeWindow,
  timeWindowShape,
  type BackendFilters,
} from "./params.js";

// ---------------------------------------------------------------------------
// Closed set of filter fields the traces list endpoint honours.
//
// Derived from respan-backend clickhouse/views/traces.py::TracesQueryBuilder.
// The builder routes each filter by field name into one of three stages and
// silently drops anything that lands in no stage's allowlist
// (clickhouse/utils/ch_aggregations.py::_compile_entry_list), so this list is
// the whole contract. The traces field spec is built with
// `allow_map_fields=False`, so `metadata__<key>` is NOT resolvable here (it is
// on the logs list, which has Map columns).
// ---------------------------------------------------------------------------

/** Trace-level rollups and root-span fields (get_metadata_columns + get_metric_columns). */
export const TRACE_LEVEL_FILTER_FIELDS = [
  "trace_unique_id",
  "start_time",
  "end_time",
  "timestamp",
  "name",
  "customer_identifier",
  "environment",
  "organization_key_id",
  "trace_group_identifier",
  "span_count",
  "llm_call_count",
  "error_count",
  "total_cost",
  "total_prompt_tokens",
  "total_completion_tokens",
  "total_request_tokens",
  "duration",
] as const;

/**
 * Span-level fields (SPAN_LEVEL_FILTER_FIELDS + span_unique_id). These run on
 * the raw per-span table: a trace matches when ANY of its spans matches, and
 * the returned rollups still describe the whole trace.
 */
export const SPAN_LEVEL_FILTER_FIELDS = [
  "span_unique_id",
  "span_parent_id",
  "span_name",
  "span_workflow_name",
  "model",
  "deployment_name",
  "provider_id",
  "status",
  "status_code",
  "error_class",
  "error_fingerprint",
  "log_type",
  "log_method",
  "prompt_id",
  "prompt_name",
  "prompt_version_number",
  "used_custom_credential",
  "cost",
  "latency",
  "time_to_first_token",
  "tokens_per_second",
  "routing_time",
  "prompt_tokens",
  "completion_tokens",
  "prompt_cache_hit_tokens",
  "prompt_cache_creation_tokens",
] as const;

/** Content fields matched on the raw span table (full-text path). */
export const TRACE_CONTENT_FILTER_FIELDS = ["input", "output", "session_identifier"] as const;

export const TRACE_FILTER_FIELDS = [
  ...TRACE_LEVEL_FILTER_FIELDS,
  ...SPAN_LEVEL_FILTER_FIELDS,
  ...TRACE_CONTENT_FILTER_FIELDS,
] as const;

export const TRACE_FILTER_FIELD_SPEC: FilterFieldSpec = {
  tool: "trace_list",
  fields: TRACE_FILTER_FIELDS,
  hint: (unsupported) => {
    const hints: string[] = [];
    if (unsupported.includes("total_tokens")) {
      hints.push("Use 'total_request_tokens' to filter on total token count ('total_tokens' is a sort field only).");
    }
    if (unsupported.some((f) => f.startsWith("metadata__") || f === "metadata")) {
      hints.push(
        "Custom metadata is not filterable on traces (the traces table has no Map columns); "
          + "use log_list with a 'metadata__<key>' filter and read trace_unique_id from its rows instead.",
      );
    }
    return hints.length > 0 ? hints.join(" ") : undefined;
  },
};

/** A subset of TRACE_SORT_FIELD_MAPPING that answers the common questions. */
export const TRACE_SORT_OPTIONS = [
  "-timestamp",
  "timestamp",
  "-total_cost",
  "-duration",
  "-error_count",
  "-total_tokens",
  "-span_count",
] as const;

const TRACE_PAGE_SIZE_DEFAULT = 5;
const TRACE_PAGE_SIZE_MAX = 10;

/** Columns trace_list returns per row. The span tree is left to trace_get. */
export const TRACE_LIST_FIELDS = [
  "trace_unique_id",
  "name",
  "start_time",
  "end_time",
  "duration",
  "span_count",
  "llm_call_count",
  "error_count",
  "total_cost",
  "total_tokens",
  "model",
  "customer_identifier",
  "environment",
  "input",
  "output",
] as const;

/** Span content dropped when even shortened strings cannot fit the budget. */
const SPAN_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "input",
  "output",
  "prompt_messages",
  "completion_message",
  "full_request",
  "full_response",
  "metadata",
]);

/** List rows carry previews only; trace_get has the full text. */
const TRACE_PREVIEW_CHARS = 200;
const TRACE_LIST_BUDGET = { maxChars: 20_000, stringCaps: [80] };
const TRACE_DETAIL_BUDGET = { maxChars: 60_000, stringCaps: [2_000, 600, 200] };

function projectTraceRow(row: unknown): Record<string, unknown> {
  const source = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of TRACE_LIST_FIELDS) {
    if (field in source) projected[field] = source[field];
  }
  return truncateStrings(projected, TRACE_PREVIEW_CHARS) as Record<string, unknown>;
}

export function registerTraceTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "trace_list",
    {
      title: "Find traces",
      description: `Find traces: complete runs of an agent or workflow, each made of many spans (LLM calls, tool calls, steps). Use it for "most expensive agent runs today", "runs that errored" or "runs for user X".

Returns one page of rollups per trace: ${TRACE_LIST_FIELDS.join(", ")}. input and output are short previews; call trace_get with a trace_unique_id to see every span.

Defaults to the last 24 hours, newest first.`,
      inputSchema: {
        ...timeWindowShape,
        ...environmentShape,
        customer_identifier: z.string().optional().describe("Only traces from this end user of your app."),
        name: z.string().optional().describe("Only traces whose root span has exactly this name (the workflow or agent name)."),
        errors_only: z.boolean().optional().describe("Only traces with at least one failed span."),
        filters: z
          .array(filterConditionSchema(
            `Trace field. Trace-level: ${TRACE_LEVEL_FILTER_FIELDS.join(", ")}. Span-level (matches if any span matches): ${SPAN_LEVEL_FILTER_FIELDS.join(", ")}. Content: ${TRACE_CONTENT_FILTER_FIELDS.join(", ")}. Custom metadata is not filterable on traces.`,
          ))
          .optional()
          .describe("Advanced: extra conditions, all of which must match. Example: [{\"field\": \"duration\", \"operator\": \"gt\", \"value\": [30]}]."),
        sort_by: z.enum(TRACE_SORT_OPTIONS).optional().describe("Sort order (default -timestamp, newest first). '-' means descending."),
        ...pageShape(TRACE_PAGE_SIZE_DEFAULT, TRACE_PAGE_SIZE_MAX),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);

      // Reject unsupported fields up front: the backend drops them silently
      // and returns a wider result set with HTTP 200.
      const guard = filterGuardError((args.filters ?? []).map((f) => f.field), TRACE_FILTER_FIELD_SPEC);
      if (guard) return guardErrorResult(guard);

      const window = resolveTimeWindow(args);
      const { page, pageSize } = resolvePage(args, TRACE_PAGE_SIZE_DEFAULT, TRACE_PAGE_SIZE_MAX);

      const filters: BackendFilters = { ...toBackendFilters(args.filters) };
      if (args.customer_identifier) {
        filters.customer_identifier = { operator: "", value: [args.customer_identifier] };
      }
      if (args.name) filters.name = { operator: "", value: [args.name] };
      if (args.errors_only) filters.error_count = { operator: "gt", value: [0] };

      const result = await rawFetch(c, "/api/traces/list/", {
        query: {
          ...window,
          environment: args.environment,
          sort_by: args.sort_by ?? "-timestamp",
          page,
          page_size: pageSize,
        },
        body: Object.keys(filters).length > 0 ? { filters } : {},
      });

      const { rows, hasMore } = readListPage(result, pageSize);
      return textResult(budgetedJson({
        ...window,
        page,
        page_size: pageSize,
        has_more: hasMore,
        results: rows.map(projectTraceRow),
      }, TRACE_LIST_BUDGET));
    },
  );

  server.registerTool(
    "trace_get",
    {
      title: "Read a trace",
      description: `Read one trace as a tree of spans, showing what the agent or workflow did step by step: each span's name, type, model, latency, cost, tokens, status, input and output, with nested children.

Get the trace_unique_id from trace_list or from a log_list row. Long span text is shortened, and for very large traces span input and output are left out; call log_get with a span's unique_id to read one span in full.`,
      inputSchema: {
        trace_id: z.string().describe("The trace_unique_id, from trace_list or log_list."),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async ({ trace_id }) => {
      const c = requireClient(client);
      const result = await rawFetch(c, `/api/traces/${encodeURIComponent(trace_id)}/`, {
        method: "GET",
      });

      const trace = omitKeys(result, INTERNAL_RESPONSE_KEYS);
      let text = budgetedJson(trace, TRACE_DETAIL_BUDGET);
      if (text.length > TRACE_DETAIL_BUDGET.maxChars) {
        text = budgetedJson({
          ...(omitKeys(trace, SPAN_CONTENT_KEYS) as Record<string, unknown>),
          note: "This trace is too large to show span input and output. Call log_get with a span's unique_id to read it.",
        }, TRACE_DETAIL_BUDGET);
      }
      return textResult(text);
    },
  );
}
