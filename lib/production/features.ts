import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BACKEND_TOOLS } from '../shared/backend-tool.js';
import { toZodShape } from '../generated/schema-to-zod.js';
import { requireClient, rawFetch, type AuthenticatedClient } from '../shared/client.js';
import { READ_ONLY_WORKSPACE_TOOL, INTERNAL_RESPONSE_KEYS, budgetedJson, omitKeys, textResult } from '../shared/tool-result.js';
import { filterGuardError } from '../shared/filter-fields.js';
import { TRACE_FILTER_FIELD_SPEC } from './traces.js';
import { timeWindowShape, environmentShape, resolveTimeWindow } from './params.js';

const METRICS = ['number_of_requests', 'total_cost', 'total_tokens', 'average_cost', 'average_tokens', 'error_count', 'error_percentage', 'average_latency', 'average_ttft', 'average_tps', 'cache_hit_percentage'] as const;
const BUDGET = { maxChars: 40_000, stringCaps: [2_000, 500, 200] };
const filtersSchema = z.record(z.object({ operator: z.string(), value: z.any() })).optional()
  .describe('Backend filter dictionary: {field: {operator, value}}. Filters select the input population before aggregation.');

function guardFilters(filters: Record<string, any>, scope: 'traces' | 'logs') {
  if ('unique_organization_id' in filters || 'organization_id' in filters) throw new Error('Organization scope comes from your credential; use workspace_switch with OAuth.');
  if (scope === 'traces') {
    const error = filterGuardError(Object.keys(filters), TRACE_FILTER_FIELD_SPEC);
    if (error) throw new Error(error.error.message);
  }
}

export function registerFeatureTools(server: McpServer, client: AuthenticatedClient | null) {
  for (const [name, route, scope] of [
    ['trace_summary', '/clickhouse/traces/summary/', 'traces'],
    ['log_summary', '/clickhouse/request-logs/summary/', 'logs'],
  ] as const) {
    const source = BACKEND_TOOLS.get(name)!;
    server.registerTool(name, {
      title: scope === 'traces' ? 'Trace totals' : 'Request totals',
      description: scope === 'traces'
        ? 'Count complete traces and summarize their duration, cost, tokens and errors. The unit is a trace, not a request. Defaults to the last 24 hours.'
        : 'Count and summarize individual requests: cost, tokens, latency, errors and optional scores. Defaults to the last 24 hours. Like the dashboard, excludes keyless spans unless filters.organization_key_id={operator:"",value:""} explicitly opts into all logs.',
      inputSchema: { ...toZodShape(source.inputSchema), ...timeWindowShape, ...environmentShape },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    }, async (args: Record<string, any>) => {
      const c = requireClient(client);
      const window = resolveTimeWindow(args);
      const filters = structuredClone(args.filters ?? {});
      guardFilters(filters, scope);
      if (scope === 'logs') {
        for (const [key, op] of [['model', 'icontains'], ['status', ''], ['customer_identifier', ''], ['used_custom_credential', '']] as const) {
          if (args[key] !== undefined) filters[key] = { operator: op, value: args[key] };
        }
        const override = filters.organization_key_id;
        if (override && override.operator === '' && override.value === '') delete filters.organization_key_id;
        else if (!override) filters.organization_key_id = { operator: 'not_empty', value: true };
      }
      const result = await rawFetch(c, route, { query: { ...window, environment: args.environment }, body: { filters } });
      const cleaned = omitKeys(result, INTERNAL_RESPONSE_KEYS) as Record<string, any>;
      if (scope === 'logs' && args.include_scores === false && cleaned && typeof cleaned === 'object') {
        delete cleaned.scores;
        if (cleaned.summary && typeof cleaned.summary === 'object') delete cleaned.summary.scores;
      }
      return textResult(budgetedJson({ ...window, unit: scope === 'traces' ? 'traces' : 'requests', summary: cleaned }, BUDGET));
    });
  }

  // One backend chart API serves two features. Errors narrows the metric
  // vocabulary; Metrics exposes the full supported request-health vocabulary.
  for (const name of ['metrics_timeseries', 'error_timeseries'] as const) {
    server.registerTool(name, {
      title: name === 'error_timeseries' ? 'Error trend' : 'Metric trend',
      description: name === 'error_timeseries'
        ? 'Request error count or error rate over time. Returns backend time buckets; do not sum percentages. Defaults to error_count, grouped by model, over the last 24 hours. These are request statistics, not trace behavior verdicts.'
        : 'One request metric over time: traffic, cost, tokens, latency or error rate. Defaults to number_of_requests, grouped by model, over the last 24 hours. Buckets and series are preserved; average/rate buckets must not be summed.',
      inputSchema: {
        ...timeWindowShape, ...environmentShape,
        metric: (name === 'error_timeseries' ? z.enum(['error_count', 'error_percentage']) : z.enum(METRICS)).optional(),
        group_by: z.enum(['model', 'deployment_name', 'customer_identifier', 'organization_key_id']).optional().describe('Series dimension; default model.'),
        time_tick: toZodShape(BACKEND_TOOLS.get('dashboard_metric_chart')!.inputSchema).time_tick,
        filters: filtersSchema,
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    }, async (args) => {
      const c = requireClient(client);
      const window = resolveTimeWindow(args);
      const metric = args.metric ?? (name === 'error_timeseries' ? 'error_count' : 'number_of_requests');
      const result = await rawFetch(c, '/clickhouse/dashboard/time-series/breakdown/', {
        query: { ...window, environment: args.environment, breakdown_by: args.group_by ?? 'model', time_tick: args.time_tick },
        body: { filters: args.filters ?? {}, metrics_to_aggregate: [metric] },
      });
      return textResult(budgetedJson({ ...window, metric, group_by: args.group_by ?? 'model', unit: 'requests', data: omitKeys(result, INTERNAL_RESPONSE_KEYS) }, BUDGET));
    });
  }
}
