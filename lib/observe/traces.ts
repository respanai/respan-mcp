// lib/observe/traces.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { requireClient } from "../shared/client.js";

export function registerTraceTools(server: McpServer, client: AuthenticatedClient | null) {
  // --- List Traces ---
  server.tool(
    "list_traces",
    `List and filter traces with sorting, pagination, and server-side filtering.

A trace represents a complete workflow execution containing multiple spans (individual operations).

IMPORTANT: Use the "filters" parameter to filter results server-side. Do NOT fetch all traces and filter client-side.

PARAMETERS:
- page_size: Results per page (1-20, default 10)
- page: Page number (default 1)
- sort_by: Sort field with optional - prefix for descending (e.g. "-total_cost", "duration")
- start_time / end_time: ISO 8601 time range (default: last 1 hour)
- environment: Filter by environment (e.g. "production", "test")
- filters: Array of server-side filter objects. Each filter has: field (string), operator (string), value (array). See below.

FILTERS - supported operators:
"" (exact match), "not", "lt", "lte", "gt", "gte", "icontains", "startswith", "endswith", "in", "isnull"

FILTERS - supported fields:
trace_unique_id, customer_identifier, environment, span_count, llm_call_count, error_count, total_cost, total_tokens, total_prompt_tokens, total_completion_tokens, duration, workflow_name (span_workflow_name), metadata__<key>

EXAMPLE - find traces with errors:
{
  "filters": [{"field": "error_count", "operator": "gt", "value": [0]}],
  "sort_by": "-total_cost"
}

EXAMPLE - find traces for a specific customer:
{
  "filters": [
    {"field": "customer_identifier", "operator": "", "value": ["user@example.com"]},
    {"field": "total_cost", "operator": "gte", "value": [0.01]}
  ]
}

RESPONSE FIELDS:
- trace_unique_id: Unique identifier
- start_time, end_time: Trace time range
- duration: Total duration in seconds
- span_count: Number of spans
- llm_call_count: Number of LLM API calls
- total_prompt_tokens, total_completion_tokens, total_tokens: Token usage
- total_cost: Cost in USD
- error_count: Number of errors
- input, output: Root span's input/output
- metadata: Custom metadata
- customer_identifier: User identifier
- environment: Environment name
- trace_group_identifier: Workflow group
- name: Root span name
- model: Primary model used`,
    {
      page_size: z.number().optional().describe("Results per page (1-20, default 10)"),
      page: z.number().optional().describe("Page number (default 1)"),
      sort_by: z.enum(["timestamp", "-timestamp", "start_time", "-start_time", "end_time", "-end_time", "duration", "-duration", "total_cost", "-total_cost", "total_tokens", "-total_tokens", "total_prompt_tokens", "-total_prompt_tokens", "total_completion_tokens", "-total_completion_tokens", "span_count", "-span_count", "llm_call_count", "-llm_call_count", "error_count", "-error_count"]).optional().describe("Sort field. Prefix with - for descending order."),
      start_time: z.string().optional().describe("Start time in ISO 8601 format. Default: 1 hour ago"),
      end_time: z.string().optional().describe("End time in ISO 8601 format. Default: current time"),
      environment: z.string().optional().describe("Filter by environment (e.g., 'production', 'test')"),
      filters: z.array(z.object({
        field: z.string().describe("Field to filter on. Supported: trace_unique_id, customer_identifier, environment, span_count, llm_call_count, error_count, total_cost, total_tokens, total_prompt_tokens, total_completion_tokens, duration, span_workflow_name. For custom metadata use metadata__<key>."),
        operator: z.enum(["", "not", "lt", "lte", "gt", "gte", "icontains", "iexact", "contains", "startswith", "endswith", "in", "isnull"]).describe("Filter operator. '' = exact match, 'not' = not equal, 'lt'/'lte' = less than, 'gt'/'gte' = greater than, 'icontains' = case-insensitive contains, 'in' = value in list, 'isnull' = check null"),
        value: z.array(z.any()).describe("Filter value(s) as array, e.g. [0], ['production'], [true]")
      })).optional().describe("Array of server-side filters. Each filter has field, operator, and value. Example: [{\"field\": \"error_count\", \"operator\": \"gt\", \"value\": [0]}]")
    },
    async ({ page_size = 10, page = 1, sort_by = "-timestamp", start_time, end_time, environment, filters }) => {
      const c = requireClient(client);
      const limit = Math.min(page_size, 20);

      // Convert filters array to the backend body format: { field: { operator, value } }
      const bodyFilters: Record<string, any> = {};
      if (filters) {
        for (const f of filters) {
          bodyFilters[f.field] = {
            value: f.value,
            operator: f.operator || "",
          };
        }
      }

      const result = await c.client.traces.listTraces({
        Authorization: c.auth,
        page_size: limit,
        page,
        sort_by,
        ...(start_time ? { start_time } : {}),
        ...(end_time ? { end_time } : {}),
        ...(environment ? { environment } : {}),
        ...(Object.keys(bodyFilters).length > 0 ? { filters: bodyFilters } : {}),
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- Get Trace Tree ---
  server.tool(
    "get_trace_tree",
    `Retrieve the complete hierarchical span tree of a single trace.

Returns detailed trace information with the full span_tree structure showing:
- All spans in the trace with parent-child relationships
- Full input/output for each span
- Timing and performance metrics per span
- Model and token usage per LLM span
- Nested children spans forming the execution tree

TRACE FIELDS:
- trace_unique_id: Unique identifier
- start_time, end_time: Trace time range
- duration: Total duration in seconds
- span_count: Total number of spans
- llm_call_count: Number of LLM calls
- total_prompt_tokens, total_completion_tokens, total_tokens: Aggregate token usage
- total_cost: Total cost in USD
- error_count: Number of errors
- metadata: Custom metadata object
- customer_identifier: User identifier
- environment: Environment name

SPAN TREE STRUCTURE:
Each span in span_tree contains:
- span_unique_id: Unique span identifier
- span_name: Name of the operation
- span_parent_id: Parent span ID (null for root)
- log_type: Span type (CHAT, COMPLETION, FUNCTION, TASK, WORKFLOW, etc.)
- start_time, timestamp: Span timing
- latency: Duration in seconds
- input: Full span input data
- output: Full span output data
- model: Model used (for LLM spans)
- prompt_tokens, completion_tokens: Token counts
- cost: Cost in USD
- status: Status (success, error)
- status_code: HTTP-like status code
- children: Array of nested child spans

Use list_traces first to find trace_unique_id, then use this for full span tree.`,
    {
      trace_id: z.string().describe("Trace unique ID (trace_unique_id field from list_traces)"),
      environment: z.string().optional().describe("Environment filter (if trace exists in multiple environments)"),
      start_time: z.string().optional().describe("Start time filter in ISO 8601 format"),
      end_time: z.string().optional().describe("End time filter in ISO 8601 format")
    },
    async ({ trace_id, environment, start_time, end_time }) => {
      const c = requireClient(client);
      const result = await c.client.traces.retrieveTrace({
        Authorization: c.auth,
        trace_unique_id: trace_id,
        ...(environment ? { environment } : {}),
        ...(start_time ? { start_time } : {}),
        ...(end_time ? { end_time } : {}),
      });

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

}
