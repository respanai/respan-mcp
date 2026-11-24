import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../lib/shared/mcp-handler.js';
import { fitFilterSchema } from '../lib/production/filter-schema.js';
import type { AuthenticatedClient } from '../lib/shared/client.js';

async function fixture(responses: Array<{ status?: number; body: unknown }> = [{ body: {} }]) {
  let index = 0;
  const fetch = vi.fn(async () => {
    const response = responses[Math.min(index++, responses.length - 1)];
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  });
  const auth = { auth: 'Bearer fixture', baseUrl: 'https://api.example.invalid', fetch } as unknown as AuthenticatedClient;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(auth).connect(b);
  const client = new Client({ name: 'feature-test', version: '1' });
  await client.connect(a);
  const call = (i = 0) => {
    const [url, init] = fetch.mock.calls[i] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    return { method: init.method, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body: init.body ? JSON.parse(String(init.body)) : undefined };
  };
  return { client, fetch, call };
}
const window = { start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-02T00:00:00Z' };
const text = (result: any): string => result.content[0].text;

describe('model_usage_list filters', () => {
  it('forwards filters the breakdown endpoint compiles', async () => {
    const { client, call } = await fixture();
    try {
      const filters = { provider_id: { operator: '', value: 'anthropic' } };
      await client.callTool({ name: 'model_usage_list', arguments: { ...window, filters } });
      expect(call().body).toEqual({ filters });
    } finally { await client.close(); }
  });

  it('rejects filters the breakdown endpoint cannot compile before issuing a request', async () => {
    const { client, fetch } = await fixture();
    try {
      for (const field of ['behaviors', 'topics', 'fault_domain', 'messages_smart', 'unique_organization_id', 'organization_id']) {
        const result = await client.callTool({ name: 'model_usage_list', arguments: { ...window, filters: { [field]: { operator: '', value: 'x' } } } });
        expect(result.isError, field).toBe(true);
        expect(text(result), field).toContain(`Cannot filter by ${field}`);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });
});

describe('behavior_disabled_set', () => {
  it('writes the current project, never one the caller names', async () => {
    const { client, call } = await fixture([
      { body: { unique_organization_id: 'own-org' } },
      { body: { disabled_span_behaviors: [] } },
    ]);
    try {
      await client.callTool({ name: 'behavior_disabled_set', arguments: { disabled_span_behaviors: [], organization_id: 'foreign-org' } });
      expect(call(1)).toEqual({ path: '/user/organization/own-org/', query: {}, method: 'PATCH', body: { disabled_span_behaviors: [] } });
    } finally { await client.close(); }
  });

  it('changes nothing when the current project has no identifier', async () => {
    const { client, fetch } = await fixture([{ body: { name: 'Project' } }]);
    try {
      const result = await client.callTool({ name: 'behavior_disabled_set', arguments: { disabled_span_behaviors: [] } });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('no settings were changed');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await client.close(); }
  });
});

describe('log_filter_schema_get', () => {
  it('reads the backend filter schema with a GET and passes the environment', async () => {
    const schema = { filters: [{ metric: 'latency', percentiles: { p90: 4.4 } }], operators: {}, measurements: { is_measured: true } };
    const { client, call } = await fixture([{ body: schema }]);
    try {
      const result = await client.callTool({ name: 'log_filter_schema_get', arguments: { environment: 'prod' } });
      expect(call()).toEqual({ path: '/api/request-logs/filter-schema/', method: 'GET', query: { environment: 'prod' }, body: undefined });
      expect(JSON.parse(text(result))).toEqual(schema);
    } finally { await client.close(); }
  });

  it('says the backend lacks the endpoint when it answers 404', async () => {
    const { client } = await fixture([{ status: 404, body: { detail: 'Not found.' } }]);
    try {
      const result = await client.callTool({ name: 'log_filter_schema_get', arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('not available on this Respan backend');
    } finally { await client.close(); }
  });

  it('drops whole metadata example values first, keeping closed vocabularies whole', async () => {
    const value = 'tenant-value-0000000';
    const status = { metric: 'status', operators: [''], example_values: ['success', 'failed'], value_count: 2, value_labels: { failed: 'Error' } };
    const metadata = Array.from({ length: 100 }, (_, i) => ({
      metric: `metadata__key_${i}`,
      operators: ['', 'in'],
      example_values: Array.from({ length: 30 }, (__, j) => `${value}${j}`),
    }));
    const { client } = await fixture([{ body: { filters: [status, ...metadata], operators: {}, measurements: { is_measured: true } } }]);
    try {
      const result = await client.callTool({ name: 'log_filter_schema_get', arguments: {} });
      const body = JSON.parse(text(result));
      expect(text(result).length).toBeLessThanOrEqual(40_000);
      expect(body.filters).toHaveLength(101);
      expect(body.filters[0]).toEqual(status);
      expect(body.filters[1].example_values).toEqual(Array.from({ length: 10 }, (_, j) => `${value}${j}`));
    } finally { await client.close(); }
  });

  it('drops the labels of values it drops, then metadata keys as a last resort', () => {
    const ids = Array.from({ length: 30 }, (_, j) => `prompt-${j}`);
    const prompt = {
      metric: 'prompt_id',
      example_values: ids,
      value_count: 30,
      value_labels: Object.fromEntries(ids.map((id) => [id, 'x'.repeat(2_000)])),
    };
    const metadata = Array.from({ length: 100 }, (_, i) => ({ metric: `metadata__${'k'.repeat(400)}${i}` }));

    const body = JSON.parse(fitFilterSchema({ filters: [prompt, ...metadata], metadata_filters_omitted: 5 }));

    expect(body.filters).toEqual([{ ...prompt, example_values: ids.slice(0, 3), value_labels: Object.fromEntries(ids.slice(0, 3).map((id) => [id, 'x'.repeat(2_000)])) }]);
    expect(body.metadata_filters_omitted).toBe(105);
  });

  it('still reports other backend errors', async () => {
    const { client } = await fixture([{ status: 403, body: 'denied' }]);
    try {
      const result = await client.callTool({ name: 'log_filter_schema_get', arguments: {} });
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/403/);
    } finally { await client.close(); }
  });
});

describe('ab_test tools', () => {
  const split = {
    id: 'ab1', name: 'nano vs haiku', created_at: '2026-11-24T06:59:15Z', running_status: 'pending', skipped_sessions: 0,
    run_config: { model: 'gpt-4o-mini', live_sampling: { mode: 'split', budget_usd: 1, sample_rate_basis_points: 7000,
      variants: [{ name: 'nano', model: 'gpt-4.1-nano', share_basis_points: 3500 }, { name: 'haiku', model: 'claude-haiku-4-5', share_basis_points: 3500 }] } },
  };
  const side = (cost: number) => ({ body: { total_count: 4, total_span_count: 8, total_cost: cost, avg_latency: 0.5, total_tokens: 100 } });

  it('ab_test_summary reads each split side\'s calls and sessions by its metadata', async () => {
    const calls = (cost: number) => ({ body: { number_of_requests: 8, total_cost: cost, avg_latency: 0.5, total_tokens: 100 } });
    const sessions = { body: { total_count: 4 } };
    const { client, call, fetch } = await fixture([{ body: split }, calls(0.1), sessions, calls(0.2), sessions, calls(0.3), sessions]);
    try {
      const result = await client.callTool({ name: 'ab_test_summary', arguments: { ab_test_id: 'ab1' } });
      expect(call(0)).toMatchObject({ method: 'GET', path: '/api/datasets/ab1/versions/ab1/' });
      expect(fetch).toHaveBeenCalledTimes(7);
      const reads = [1, 2, 3, 4, 5, 6].map((i) => call(i));
      expect(new Set(reads.map((c) => c.path))).toEqual(new Set(['/api/request-logs/summary/', '/clickhouse/threads/summary/']));
      expect(new Set(reads.map((c) => c.body.filters.metadata__ab_test_side.value))).toEqual(new Set(['primary', 'nano', 'haiku']));
      expect(reads.every((c) => c.body.filters.metadata__ab_test_id.value === 'ab1' && c.query.start_time === split.created_at)).toBe(true);
      const data = JSON.parse(text(result));
      expect(data.state).toBe('running');
      expect(data.sides.map((s: any) => s.side)).toEqual(['primary', 'nano', 'haiku']);
      expect(data.sides.map((s: any) => s.model)).toEqual([null, 'gpt-4.1-nano', 'claude-haiku-4-5']);
      expect(data.sides.every((s: any) => s.sessions === 4 && s.calls === 8)).toBe(true);
    } finally { await client.close(); }
  });

  it('ab_test_update pauses through the run route and extends through the test', async () => {
    const { client, call } = await fixture([{ body: {} }, { body: {} }]);
    try {
      await client.callTool({ name: 'ab_test_update', arguments: { ab_test_id: 'ab1', status: 'paused' } });
      await client.callTool({ name: 'ab_test_update', arguments: { ab_test_id: 'ab1', live_sampling: { budget_usd: 5 } } });
      expect(call(0)).toEqual({ method: 'PATCH', path: '/api/datasets/ab1/run/', query: {}, body: { status: 'paused' } });
      expect(call(1)).toEqual({ method: 'PATCH', path: '/api/datasets/ab1/', query: {}, body: { live_sampling: { budget_usd: 5 } } });
    } finally { await client.close(); }
  });

  it('ab_test_stop cancels the run', async () => {
    const { client, call } = await fixture();
    try {
      await client.callTool({ name: 'ab_test_stop', arguments: { ab_test_id: 'ab1' } });
      expect(call()).toEqual({ method: 'PATCH', path: '/api/datasets/ab1/run/', query: {}, body: { status: 'cancelled' } });
    } finally { await client.close(); }
  });
});
