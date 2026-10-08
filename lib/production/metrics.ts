// lib/production/metrics.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch, requireClient } from "../shared/client.js";
import {
  INTERNAL_RESPONSE_KEYS,
  READ_ONLY_WORKSPACE_TOOL,
  budgetedJson,
  omitKeys,
  textResult,
} from "../shared/tool-result.js";
import {
  environmentShape,
  resolveTimeWindow,
  timeWindowShape,
  type BackendFilters,
} from "./params.js";

/** Metrics the dashboard breakdown endpoint ranks by (dashboard_tools._SORT_BY_PROPERTY). */
export const RANK_METRICS = [
  "number_of_requests",
  "total_cost",
  "total_tokens",
  "error_count",
  "average_latency",
] as const;

/** Columns kept per ranked row; the endpoint returns ~30 per row. */
const RANKED_ROW_FIELDS = [
  "model",
  "customer_identifier",
  "name",
  "email",
  "number_of_requests",
  "total_cost",
  "average_cost",
  "total_tokens",
  "error_count",
  "error_percentage",
  "average_latency",
] as const;

const RANK_LIMIT_DEFAULT = 10;
const RANK_LIMIT_MAX = 50;

const METRICS_BUDGET = { maxChars: 20_000, stringCaps: [200] };

const providerIdSchema = z
  .string()
  .optional()
  .describe("Only this provider, by slug: openai, anthropic, azure, azure_openai, bedrock, google_gemini_ai, google_vertex_ai, mistral, groq, deepseek, xai, openrouter, etc.");

const rankShape = {
  sort_by: z.enum(RANK_METRICS).optional().describe("Metric to rank by (default number_of_requests)."),
  limit: z.number().int().min(1).optional().describe(`How many to return (default ${RANK_LIMIT_DEFAULT}, max ${RANK_LIMIT_MAX}).`),
};

// The dashboard views read one scalar per filter leaf, unlike the list
// endpoints, which take arrays.
function dashboardFilters(conditions: Record<string, { operator: string; value: string | undefined }>) {
  const filters: BackendFilters = {};
  for (const [field, condition] of Object.entries(conditions)) {
    if (condition.value) filters[field] = condition;
  }
  return filters;
}

/** The breakdown endpoint answers `{ "<metric>": [rows] }`; return the rows. */
function rankedRows(result: unknown): Record<string, unknown>[] {
  let rows: unknown[] = [];
  if (Array.isArray(result)) {
    rows = result;
  } else if (result && typeof result === "object") {
    rows = Object.values(result).find(Array.isArray) ?? [];
  }
  return rows.map((row) => {
    const source = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const field of RANKED_ROW_FIELDS) {
      if (field in source) projected[field] = source[field];
    }
    return projected;
  });
}

async function rankBy(
  client: AuthenticatedClient,
  breakdownBy: string,
  args: {
    start_time?: string;
    end_time?: string;
    environment?: string;
    sort_by?: (typeof RANK_METRICS)[number];
    limit?: number;
  },
  filters: BackendFilters,
) {
  const window = resolveTimeWindow(args);
  const sortBy = args.sort_by ?? "number_of_requests";
  const result = await rawFetch(client, "/api/dashboard/breakdown/", {
    query: {
      ...window,
      environment: args.environment,
      breakdown_by: breakdownBy,
      include_all_metrics: "true",
      sort_by: sortBy,
      limit: Math.min(args.limit ?? RANK_LIMIT_DEFAULT, RANK_LIMIT_MAX),
    },
    body: { filters },
  });
  return textResult(budgetedJson({
    ...window,
    ranked_by: sortBy,
    results: rankedRows(result),
  }, METRICS_BUDGET));
}

export function registerMetricTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "dashboard_llm_metrics_summary",
    {
      title: "Usage and health summary",
      description: `Totals for a time range: number of requests, total cost (USD), total tokens, average latency, time to first token, error count and error rate. Use it for "how is my app doing", "what did we spend this week" or "what is our error rate".

To compare periods, call it once per period with windows of equal length. Defaults to the last 24 hours.`,
      inputSchema: {
        ...timeWindowShape,
        ...environmentShape,
        model: z.string().optional().describe("Only models whose name contains this text, e.g. 'gpt-4o'."),
        provider_id: providerIdSchema,
        customer_identifier: z.string().optional().describe("Only requests from this end user of your app."),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const window = resolveTimeWindow(args);
      const result = await rawFetch(c, "/api/dashboard/llm-metrics/summary/", {
        query: { ...window, environment: args.environment },
        body: {
          filters: dashboardFilters({
            model: { operator: "icontains", value: args.model },
            provider_id: { operator: "", value: args.provider_id },
            customer_identifier: { operator: "", value: args.customer_identifier },
          }),
        },
      });
      return textResult(budgetedJson({
        ...window,
        summary: omitKeys(result, INTERNAL_RESPONSE_KEYS),
      }, METRICS_BUDGET));
    },
  );

  server.registerTool(
    "dashboard_top_models",
    {
      title: "Top models",
      description: `Rank the models your app called in a time range by requests, cost, tokens, errors or latency. Each row has the model with its request count, total cost (USD), tokens, average latency and error count. Use it for "which model costs the most" or "which model fails most".

Defaults to the last 24 hours, ranked by number of requests.`,
      inputSchema: {
        ...timeWindowShape,
        ...environmentShape,
        provider_id: providerIdSchema,
        ...rankShape,
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      return rankBy(c, "model", args, dashboardFilters({
        provider_id: { operator: "", value: args.provider_id },
      }));
    },
  );

  server.registerTool(
    "end_user_rank_by_usage",
    {
      title: "Top end users",
      description: `Rank the end users of your app (by customer_identifier) in a time range by requests, cost, tokens, errors or latency. Use it for "who are my heaviest users" or "which users hit the most errors". These are your app's users, not members of your Respan team.

Defaults to the last 24 hours, ranked by number of requests.`,
      inputSchema: {
        ...timeWindowShape,
        ...environmentShape,
        model: z.string().optional().describe("Only models whose name contains this text, e.g. 'gpt-4o'."),
        ...rankShape,
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      return rankBy(c, "customer_identifier", args, dashboardFilters({
        model: { operator: "icontains", value: args.model },
      }));
    },
  );
}
