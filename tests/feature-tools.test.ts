import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../lib/shared/mcp-handler.js';
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

describe('feature-oriented MCP contracts', () => {
  it('exposes eight categories and the agreed feature operations without a conversation product', async () => {
    const { client } = await fixture();
    try {
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name);
      expect(tools).toHaveLength(54);
      expect(new Set(tools.map(t => t._meta?.['respan/category'])).size).toBe(8);
      for (const name of ['trace_summary', 'log_summary', 'behavior_summary', 'behavior_records', 'behavior_settings_get', 'behavior_settings_update', 'error_group_list', 'error_group_get', 'error_timeseries', 'incident_list', 'metrics_summary', 'metrics_timeseries', 'metrics_grouped', 'user_usage_list', 'monitor_alert_list', 'monitor_alert_timeseries', 'notification_destination_list', 'notification_destination_get', 'prompt_version_list', 'prompt_draft_update', 'workspace_current', 'workspace_list', 'workspace_switch']) expect(names).toContain(name);
      for (const name of ['thread_list', 'thread_get', 'pulse_behaviors_summary', 'org_list']) expect(names).not.toContain(name);
    } finally { await client.close(); }
  });

  it('defaults behavior analysis to whole traces but preserves an explicit gateway scope', async () => {
    const { client, call } = await fixture();
    try {
      await client.callTool({ name: 'behavior_summary', arguments: window });
      await client.callTool({ name: 'behavior_records', arguments: { ...window, behavior: 'refusal', scope: 'spans' } });
      expect(call()).toMatchObject({ path: '/api/pulses/behaviors/', body: { ...window, scope: 'traces' } });
      expect(call(1)).toMatchObject({ path: '/api/pulses/behaviors/logs/', body: { ...window, behavior: 'refusal', scope: 'spans' } });
    } finally { await client.close(); }
  });

  it('reuses the chart API with feature-specific metric bounds and preserves buckets', async () => {
    const buckets = { error_percentage: [{ date_group: '2026-10-01', modelA: 20 }, { date_group: '2026-10-02', modelA: 0 }] };
    const { client, call, fetch } = await fixture([{ body: buckets }]);
    try {
      const invalid = await client.callTool({ name: 'error_timeseries', arguments: { ...window, metric: 'total_cost' } });
      expect(invalid.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      const result = await client.callTool({ name: 'error_timeseries', arguments: { ...window, metric: 'error_percentage', time_tick: 'day' } });
      await client.callTool({ name: 'metrics_timeseries', arguments: { ...window, metric: 'total_cost' } });
      expect(call()).toMatchObject({ path: '/clickhouse/dashboard/time-series/breakdown/', body: { filters: {}, metrics_to_aggregate: ['error_percentage'] } });
      expect(call(1)).toMatchObject({ path: '/clickhouse/dashboard/time-series/breakdown/', body: { filters: {}, metrics_to_aggregate: ['total_cost'] } });
      expect(JSON.parse((result.content as any)[0].text).data).toEqual(buckets);
    } finally { await client.close(); }
  });

  it('distinguishes trace totals from request totals and supports the intentional all-logs override', async () => {
    const { client, call } = await fixture();
    try {
      const traces = await client.callTool({ name: 'trace_summary', arguments: window });
      await client.callTool({ name: 'log_summary', arguments: window });
      const logs = await client.callTool({ name: 'log_summary', arguments: { ...window, filters: { organization_key_id: { operator: '', value: '' } } } });
      expect(call()).toMatchObject({ path: '/clickhouse/traces/summary/', body: { filters: {} } });
      expect(call(1)).toMatchObject({ path: '/clickhouse/request-logs/summary/', body: { filters: { organization_key_id: { operator: 'not_empty', value: true } } } });
      expect(call(2)).toMatchObject({ body: { filters: {} } });
      expect(JSON.parse((traces.content as any)[0].text).unit).toBe('traces');
      expect(JSON.parse((logs.content as any)[0].text).unit).toBe('requests');
    } finally { await client.close(); }
  });

  it('rejects unsupported trace filters and foreign organization scope before issuing a request', async () => {
    const { client, fetch } = await fixture();
    try {
      for (const filters of [{ metadata__tenant: { operator: '', value: 'x' } }, { unique_organization_id: { operator: '', value: 'other-org' } }]) {
        const result = await client.callTool({ name: 'trace_summary', arguments: { ...window, filters } });
        expect(result.isError).toBe(true);
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it('groups providers through the ranking API while respecting the selected environment', async () => {
    const { client, call } = await fixture([{ body: { total_cost: [{ provider_id: 'anthropic', total_cost: 5 }] } }]);
    try {
      const result = await client.callTool({ name: 'metrics_grouped', arguments: { ...window, group_by: 'provider_id', environment: 'prod', sort_by: 'total_cost' } });
      expect(call()).toMatchObject({ path: '/api/dashboard/breakdown/', query: { start_time: new Date(window.start_time).toISOString(), end_time: new Date(window.end_time).toISOString(), environment: 'prod', breakdown_by: 'provider_id', include_all_metrics: 'true', sort_by: 'total_cost', limit: '10' } });
      expect(JSON.parse((result.content as any)[0].text).results[0]).toEqual({ provider_id: 'anthropic', total_cost: 5 });
    } finally { await client.close(); }
  });

  it('resolves behavior settings writes from the current session and exposes only the disabled list', async () => {
    const { client, call } = await fixture([
      { body: { unique_organization_id: 'own-org', disabled_span_behaviors: ['refusal'], secret: 'private' } },
      { body: { unique_organization_id: 'own-org' } },
      { body: { disabled_span_behaviors: [], secret: 'private' } },
    ]);
    try {
      const read = await client.callTool({ name: 'behavior_settings_get', arguments: {} });
      const write = await client.callTool({ name: 'behavior_settings_update', arguments: { disabled_span_behaviors: [], organization_id: 'foreign-org' } });
      expect(JSON.parse((read.content as any)[0].text)).toEqual({ disabled_span_behaviors: ['refusal'] });
      expect(call(2)).toEqual({ path: '/user/organization/own-org/', query: {}, method: 'PATCH', body: { disabled_span_behaviors: [] } });
      expect(JSON.parse((write.content as any)[0].text)).toEqual({ disabled_span_behaviors: [] });
    } finally { await client.close(); }
  });

  it('does not update behavior settings when current-workspace identity is missing', async () => {
    const { client, fetch } = await fixture([{ body: { name: 'Workspace' } }]);
    try {
      const result = await client.callTool({ name: 'behavior_settings_update', arguments: { disabled_span_behaviors: [] } });
      expect(result.isError).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await client.close(); }
  });
});
