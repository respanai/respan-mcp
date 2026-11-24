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
/** running_status in plain words: `pending` is a test still sampling. */
const STATES: Record<string, string> = { pending: 'running', paused: 'paused', completed: 'ended' };
/** A split test's calls are read from its start to a minute from now. */
const WINDOW_END_SLACK_MS = 60_000;

type Json = Record<string, any>;

interface Side {
  side: string;
  model: string | null;
  sessions: number | null;
  calls: number | null;
  cost_usd: number | null;
  avg_latency_seconds: number | null;
  total_tokens: number | null;
  average_final_score: number | null;
}

const enc = encodeURIComponent;

async function getJson(client: AuthenticatedClient, path: string, init: Parameters<typeof rawFetch>[2]): Promise<Json> {
  const result = await rawFetch(client, path, init);
  return result && typeof result === 'object' && !Array.isArray(result) ? (result as Json) : {};
}

function datasetSide(side: string, model: string | null, summary: Json, sessions: number | null): Side {
  return {
    side,
    model,
    sessions,
    calls: summary.number_of_requests ?? null,
    cost_usd: summary.total_cost ?? null,
    avg_latency_seconds: summary.avg_latency ?? null,
    total_tokens: summary.total_tokens ?? null,
    average_final_score: summary.final_score_summary?.average_final_score ?? null,
  };
}

/** Primary = the sessions dataset's rows (what users got), variant = the replays of the same sessions. */
async function shadowSides(client: AuthenticatedClient, test: Json) {
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
  const variantSide = datasetSide(DEFAULT_VARIANT, test.run_config?.model ?? null, variant, sessions);
  return { sides: [datasetSide(SIDE_PRIMARY, null, primary, sessions), variantSide], spent_usd: variantSide.cost_usd };
}

/**
 * Each side's live calls, by the test id and side their metadata carries: the
 * calls themselves for calls, cost and latency (a session may hold calls
 * another test served), the sessions summary for how many sessions.
 */
async function splitSides(client: AuthenticatedClient, test: Json, sampling: Json) {
  const variants: Json[] = sampling.variants?.length ? sampling.variants : [{ name: DEFAULT_VARIANT, model: test.run_config?.model ?? null }];
  const query = { start_time: String(test.created_at), end_time: new Date(Date.now() + WINDOW_END_SLACK_MS).toISOString() };
  const named: Array<[string, string | null]> = [[SIDE_PRIMARY, null], ...variants.map((v): [string, string | null] => [v.name, v.model ?? null])];
  const sides = await Promise.all(named.map(async ([side, model]): Promise<Side> => {
    const body = { filters: {
      metadata__ab_test_id: { operator: '', value: test.id },
      metadata__ab_test_side: { operator: '', value: side },
    } };
    const [calls, sessions] = await Promise.all([
      getJson(client, '/api/request-logs/summary/', { method: 'POST', query, body }),
      getJson(client, '/clickhouse/threads/summary/', { method: 'POST', query, body }),
    ]);
    return {
      side,
      model,
      sessions: sessions.total_count ?? null,
      calls: calls.number_of_requests ?? null,
      cost_usd: calls.total_cost ?? null,
      avg_latency_seconds: calls.avg_latency ?? null,
      total_tokens: calls.total_tokens ?? null,
      average_final_score: null,
    };
  }));
  const spent = sides.filter((s) => s.side !== SIDE_PRIMARY).reduce((sum, s) => sum + (s.cost_usd ?? 0), 0);
  return { sides, spent_usd: spent };
}

export async function summarizeAbTest(client: AuthenticatedClient, abTestId: string): Promise<Json> {
  const test = await getJson(client, `/api/datasets/${enc(abTestId)}/versions/${enc(abTestId)}/`, { method: 'GET' });
  const sampling: Json = test.run_config?.live_sampling ?? {};
  const mode = sampling.mode ?? 'shadow';
  const sides = mode === SPLIT ? await splitSides(client, test, sampling) : await shadowSides(client, test);
  return {
    id: test.id,
    name: test.name,
    mode,
    state: STATES[test.running_status] ?? null,
    running_status: test.running_status,
    live_sampling_stop_reason: test.live_sampling_stop_reason ?? null,
    sample_rate_basis_points: sampling.sample_rate_basis_points ?? null,
    budget_usd: sampling.budget_usd ?? null,
    expires_at: sampling.expires_at ?? null,
    skipped_sessions: test.skipped_sessions ?? null,
    failure_causes: test.failure_causes ?? [],
    ...sides,
  };
}

export function registerAbTestSummary(server: McpServer, client: AuthenticatedClient | null): void {
  registerBackendTool(server, client, 'ab_test_summary', READ_ONLY_WORKSPACE_TOOL, (c, args) => {
    const id = args.ab_test_id;
    if (typeof id !== 'string' || !id) throw new Error('ab_test_id is required.');
    return summarizeAbTest(c, id);
  });
}
