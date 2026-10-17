// lib/production/filter-schema.ts
//
// The log filters the caller's project can set, so an agent writes its own
// `filters` instead of guessing field names, values and thresholds. The backend
// serves the catalog Respan's own natural-language search reads: what each
// field means, the project's own values and its measured percentiles. Here the
// agent is the model, so no search model is called.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch, requireClient } from "../shared/client.js";
import { READ_ONLY_WORKSPACE_TOOL, textResult } from "../shared/tool-result.js";

const FILTER_SCHEMA_PATH = "/api/request-logs/filter-schema/";

/** Upper bound on the serialized schema, in characters. */
const FILTER_SCHEMA_MAX_CHARS = 40_000;
const METADATA_PREFIX = "metadata__";
const EXAMPLE_VALUES_KEY = "example_values";
const VALUE_LABELS_KEY = "value_labels";
const METADATA_OMITTED_KEY = "metadata_filters_omitted";

interface FitStep {
  /** example_values kept per filter. */
  cap: number;
  /** Cap only metadata keys, whose values are an open-ended sample anyway. */
  isMetadataOnly: boolean;
}

/**
 * Tried in order until the schema fits. Values are dropped whole, never
 * shortened: an agent copies them into filters, and a shortened value matches
 * nothing. Metadata samples go first, so closed vocabularies (status, log_type)
 * stay complete as long as possible.
 */
const FIT_STEPS: readonly FitStep[] = [
  { cap: 10, isMetadataOnly: true },
  { cap: 0, isMetadataOnly: true },
  { cap: 10, isMetadataOnly: false },
  { cap: 3, isMetadataOnly: false },
];

function isMetadataFilter(entry: Record<string, unknown>): boolean {
  return typeof entry.metric === "string" && entry.metric.startsWith(METADATA_PREFIX);
}

function withExampleValuesCapped(entry: Record<string, unknown>, cap: number): Record<string, unknown> {
  const values = entry[EXAMPLE_VALUES_KEY];
  if (!Array.isArray(values) || values.length <= cap) return entry;
  const kept = values.slice(0, cap);
  const capped: Record<string, unknown> = { ...entry, [EXAMPLE_VALUES_KEY]: kept };
  const labels = entry[VALUE_LABELS_KEY];
  if (labels && typeof labels === "object") {
    const keptKeys = new Set(kept.map(String));
    capped[VALUE_LABELS_KEY] = Object.fromEntries(
      Object.entries(labels).filter(([value]) => keptKeys.has(value)),
    );
  }
  return capped;
}

function applyFitStep(body: Record<string, unknown>, filters: unknown[], step: FitStep): Record<string, unknown> {
  return {
    ...body,
    filters: filters.map((filter) => {
      if (!filter || typeof filter !== "object") return filter;
      const entry = filter as Record<string, unknown>;
      if (step.isMetadataOnly && !isMetadataFilter(entry)) return entry;
      return withExampleValuesCapped(entry, step.cap);
    }),
  };
}

/** Last resort: drops the metadata keys, counting them as omitted like the backend does. */
function withoutMetadataFilters(body: Record<string, unknown>, filters: unknown[]): Record<string, unknown> {
  const kept = filters.filter(
    (filter) => !(filter && typeof filter === "object" && isMetadataFilter(filter as Record<string, unknown>)),
  );
  const previouslyOmitted = typeof body[METADATA_OMITTED_KEY] === "number" ? body[METADATA_OMITTED_KEY] : 0;
  return { ...body, filters: kept, [METADATA_OMITTED_KEY]: previouslyOmitted + filters.length - kept.length };
}

/**
 * The backend serves up to 100 metadata keys with 30 example values each, plus
 * the model, provider and customer vocabularies: values, then metadata keys,
 * are dropped before the result floods the client's context.
 */
export function fitFilterSchema(schema: unknown): string {
  let text = JSON.stringify(schema);
  if (text.length <= FILTER_SCHEMA_MAX_CHARS || !schema || typeof schema !== "object") return text;
  const body = schema as Record<string, unknown>;
  if (!Array.isArray(body.filters)) return text;
  let fitted = body;
  for (const step of FIT_STEPS) {
    fitted = applyFitStep(body, body.filters, step);
    text = JSON.stringify(fitted);
    if (text.length <= FILTER_SCHEMA_MAX_CHARS) return text;
  }
  return JSON.stringify(withoutMetadataFilters(fitted, fitted.filters as unknown[]));
}

/** rawFetch's error text for an endpoint this backend does not serve. */
const NOT_FOUND_PREFIX = "404 ";

const NOT_SERVED_MESSAGE =
  "log_filter_schema_get is not available on this Respan backend yet. Write log_list and log_summary "
  + "filters from their field descriptions instead (e.g. latency in seconds, cost in US dollars, "
  + "'metadata__<key>' for custom metadata). Backend said: ";

export function registerFilterSchemaTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "log_filter_schema_get",
    {
      description: `List this project's log filters for log_list and log_summary, as the Respan UI offers them: each field (metric), its operators, its meaning, this project's own values and, for numbers, measured percentiles.

Call it when unsure of a field or value, or for vague asks like "slow" or "expensive": use a percentile as the threshold, e.g. latency gte p90. measured_over names the rows a percentile covers (e.g. log_type = 'chat'); add it as a condition too, or the threshold also matches rows outside it. Units: latency in seconds, cost in US dollars. A field can take several conditions, AND-ed: cost gte 0.05 and cost lt 1 is a range.

Listed values can be partial: value_count is the total, metadata values are a sample, and metadata_filters_omitted counts unlisted keys. An unlisted value may still exist; 'metadata__<key>' works for any key. measurements.is_measured is false while a project or environment is first measured: filter from the descriptions now and call again later, not in a loop.`,
      inputSchema: {
        environment: z.string().optional().describe("Measure values and percentiles in this environment only. Pass the environment the following log_list or log_summary call will use. Default: all environments."),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      let result: unknown;
      try {
        result = await rawFetch(c, FILTER_SCHEMA_PATH, {
          method: "GET",
          query: { environment: args.environment },
        });
      } catch (error) {
        // Backends without the endpoint route it to the log detail view, which
        // answers a 404 naming a log called "filter-schema".
        if (error instanceof Error && error.message.startsWith(NOT_FOUND_PREFIX)) {
          return { isError: true as const, content: [{ type: "text" as const, text: NOT_SERVED_MESSAGE + error.message }] };
        }
        throw error;
      }
      return textResult(fitFilterSchema(result));
    },
  );
}
