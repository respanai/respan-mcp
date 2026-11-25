// lib/ab-tests/summary.ts
//
// ab_test_summary: an A/B test's sides next to each other, read the way the
// backend executor reads them (utils/mcp/tools/ab_test_tools.py in
// respan-backend). One call per side, so it is not a route.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBackendTool } from '../shared/backend-tool.js';
import { rawFetch, type AuthenticatedClient } from '../shared/client.js';
import { READ_ONLY_WORKSPACE_TOOL } from '../shared/tool-result.js';

const SIDE_PRIMARY = 'primary';
const DEFAULT_VARIANT = 'variant';
const SPLIT = 'split';
/** A split test's calls are read from its start to a minute from now. */
const WINDOW_END_SLACK_MS = 60_000;

type Json = Record<string, any>;

/** One side, in the summary endpoints' own keys. */
interface Side {
  model: string | null;
  total_count: number | null;
  number_of_requests: number | null;
  total_cost: number | null;
  avg_latency: number | null;
  total_tokens: number | null;
  average_final_score: number | null;
}

const enc = encodeURIComponent;

async function getJson(client: AuthenticatedClient, path: string, init: Parameters<typeof rawFetch>[2]): Promise<Json> {
  const result = await rawFetch(client, path, init);
  return result && typeof result === 'object' && !Array.isArray(result) ? (result as Json) : {};
}

function side(model: string | null, summary: Json, totalCount: number | null): Side {
  return {
    model,
    total_count: totalCount,
    number_of_requests: summary.number_of_requests ?? null,
    total_cost: summary.total_cost ?? null,
    avg_latency: summary.avg_latency ?? null,
    total_tokens: summary.total_tokens ?? null,
    // A split side's calls summary has no final score: it is not scored.
    average_final_score: summary.final_score_summary?.average_final_score ?? null,
  };
}

/** Primary = the sessions dataset's rows (what users got), variant = the replays of the same sessions. */
async function shadowSides(client: AuthenticatedClient, test: Json): Promise<Record<string, Side>> {
  // A test whose sessions dataset was deleted has its replays only.
  const baseline = test.source_dataset ? String(test.source_dataset) : null;
  const [primary, variant, comparison] = await Promise.all([
    baseline ? getJson(client, `/api/datasets/${enc(baseline)}/logs/summary/`, { method: 'POST', body: {} }) : Promise.resolve({} as Json),
    getJson(client, `/api/datasets/${enc(test.id)}/logs/summary/`, { method: 'POST', body: {} }),
    baseline
      ? getJson(client, `/api/datasets/${enc(baseline)}/versions/comparison/`, {
        method: 'GET', query: { version_ids: `${baseline},${test.id}`, page_size: 1 },
      })
      : Promise.resolve({} as Json),
  ]);
  const sessions = comparison.total_count ?? null;
  return {
    [SIDE_PRIMARY]: side(null, primary, sessions),
    [DEFAULT_VARIANT]: side(test.run_config?.model ?? null, variant, sessions),
  };
}

/**
 * Each side's live calls, by the test id and side their metadata carries: the
 * calls themselves for calls, cost and latency (a session may hold calls
 * another test served), the sessions summary for how many sessions.
 */
async function splitSides(client: AuthenticatedClient, test: Json, sampling: Json): Promise<Record<string, Side>> {
  const variants: Json[] = sampling.variants?.length ? sampling.variants : [{ name: DEFAULT_VARIANT, model: test.run_config?.model ?? null }];
  const query = { start_time: String(test.created_at), end_time: new Date(Date.now() + WINDOW_END_SLACK_MS).toISOString() };
  const named: Array<[string, string | null]> = [[SIDE_PRIMARY, null], ...variants.map((v): [string, string | null] => [v.name, v.model ?? null])];
  const sides = await Promise.all(named.map(async ([name, model]): Promise<[string, Side]> => {
    const body = { filters: {
      metadata__ab_test_id: { operator: '', value: test.id },
      metadata__ab_test_side: { operator: '', value: name },
    } };
    const [calls, sessions] = await Promise.all([
      getJson(client, '/api/request-logs/summary/', { method: 'POST', query, body }),
      getJson(client, '/clickhouse/threads/summary/', { method: 'POST', query, body }),
    ]);
    return [name, side(model, calls, sessions.total_count ?? null)];
  }));
  return Object.fromEntries(sides);
}

export async function summarizeAbTest(client: AuthenticatedClient, abTestId: string): Promise<Json> {
  const test = await getJson(client, `/api/datasets/${enc(abTestId)}/versions/${enc(abTestId)}/`, { method: 'GET' });
  const sampling: Json = test.run_config?.live_sampling ?? {};
  const mode = sampling.mode ?? 'shadow';
  return {
    id: test.id,
    name: test.name,
    mode,
    running_status: test.running_status ?? null,
    live_sampling_stop_reason: test.live_sampling_stop_reason ?? null,
    sampling_rate: sampling.sampling_rate ?? null,
    budget_usd: sampling.budget_usd ?? null,
    expires_at: sampling.expires_at ?? null,
    skipped_sessions: test.skipped_sessions ?? null,
    failure_causes: test.failure_causes ?? [],
    ab_test_side: mode === SPLIT ? await splitSides(client, test, sampling) : await shadowSides(client, test),
  };
}

export function registerAbTestSummary(server: McpServer, client: AuthenticatedClient | null): void {
  registerBackendTool(server, client, 'ab_test_summary', READ_ONLY_WORKSPACE_TOOL, (c, args) => {
    const id = args.ab_test_id;
    if (typeof id !== 'string' || !id) throw new Error('ab_test_id is required.');
    return summarizeAbTest(c, id);
  });
}
