import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMonitorTools } from '../lib/develop/monitors.js';
import type { AuthenticatedClient } from '../lib/shared/client.js';

const ID = 'wf-family-alert';
function fixture(responses: Array<{ status?: number; body?: unknown }> = []) {
  let index = 0;
  const fetch = vi.fn(async () => {
    const answer = responses[index++] ?? { body: { name: 'Alert', type: 'monitors' } };
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body), { status: answer.status ?? 200 });
  });
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const server = { registerTool(name: string, _config: any, handler: any) { handlers[name] = handler; } } as unknown as McpServer;
  registerMonitorTools(server, { auth: 'Bearer test', baseUrl: 'https://api.example.invalid', fetch } as unknown as AuthenticatedClient);
  const call = (i = 0) => {
    const [url, init] = fetch.mock.calls[i] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    return { path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
  };
  return { handlers, fetch, call };
}

describe('product monitor lifecycle', () => {
  it('pins list and creation to monitors, even if raw arguments name another type', async () => {
    const { handlers, call } = fixture();
    await handlers.monitor_list({ name: 'Alert', page: 2, page_size: 1000, type: 'automations' });
    expect(call()).toEqual({ path: '/api/workflows/list/', query: { page: '2', page_size: '50' }, method: 'POST', body: { filters: { type: { value: ['monitors'], operator: 'eq' }, name: { value: 'Alert', operator: 'icontains' } } } });
    await handlers.monitor_create({ name: 'Alert', tasks: [], type: 'automations' });
    expect(call(1)).toMatchObject({ path: '/api/workflows/', method: 'POST', body: { name: 'Alert', tasks: [], type: 'monitors' } });
  });
  it('rejects display names before any network operation', async () => {
    const { handlers, fetch } = fixture();
    await expect(handlers.monitor_get({ monitor_id: 'Alert' })).rejects.toThrow(/not a display name/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('prevents editing or deploying another resource kind', async () => {
    for (const name of ['monitor_update', 'monitor_deploy', 'monitor_delete']) {
      const { handlers, fetch } = fixture([{ body: { type: 'automations', name: 'Alert' } }]);
      await expect(handlers[name]({ monitor_id: ID, name: 'Changed', user_confirmation: 'Alert' })).rejects.toThrow(/not a monitor/);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('forks a complete draft after 409, preserving untouched content and real webhook secrets', async () => {
    const current = { type: 'monitors', name: 'Alert', description: 'Original', trigger_event_type: 'trace_completed', schedule_cron: null, is_starred: true, tasks: [{ id: 'send', type: 'webhook', config: { webhook_secret: 'unmasked-secret' } }], id: 'version-old', is_read_only: true };
    const { handlers, call } = fixture([
      { body: current }, { status: 409, body: { detail: 'Draft required' } }, { body: current }, { body: { id: 'new-version', type: 'monitors', tasks: current.tasks } },
    ]);
    const result = await handlers.monitor_update({ monitor_id: ID, name: 'Changed' });
    expect(call(2)).toMatchObject({ method: 'GET', query: { is_including_secrets: 'true' } });
    expect(call(3)).toEqual({ path: `/api/workflows/${ID}/versions/`, query: {}, method: 'POST', body: { type: 'monitors', name: 'Changed', description: 'Original', trigger_event_type: 'trace_completed', schedule_cron: null, is_starred: true, tasks: current.tasks } });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ is_forked_draft: true });
    expect(result.content[0].text).not.toContain('unmasked-secret');
    expect(result.content[0].text).not.toContain('webhook_secret');
  });
  it('does not fork on auth, validation or transport errors', async () => {
    for (const status of [400, 401, 500]) {
      const { handlers, fetch } = fixture([{ body: { type: 'monitors' } }, { status, body: { detail: 'failure' } }]);
      await expect(handlers.monitor_update({ monitor_id: ID, name: 'Changed' })).rejects.toThrow(String(status));
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });
  it('only deletes when the supplied confirmation matches the current name', async () => {
    const wrong = fixture();
    await expect(wrong.handlers.monitor_delete({ monitor_id: ID, user_confirmation: 'Wrong' })).rejects.toThrow(/exactly match/);
    expect(wrong.fetch).toHaveBeenCalledTimes(1);
    const correct = fixture([{ body: { type: 'monitors', name: 'Alert' } }, { status: 204 }]);
    await correct.handlers.monitor_delete({ monitor_id: ID, user_confirmation: 'Alert' });
    expect(correct.call(1)).toMatchObject({ method: 'DELETE', path: `/api/workflows/${ID}/` });
  });
  it('uses commit/deployment routes and returns a useful result for 204 undeploy', async () => {
    const { handlers, call } = fixture([
      { body: { type: 'monitors' } }, { body: { version: 3 } },
      { body: { type: 'monitors' } }, { body: { version: 3 } },
      { body: { type: 'monitors' } }, { status: 204 },
    ]);
    await handlers.monitor_commit({ monitor_id: ID, version_description: 'Threshold change' });
    await handlers.monitor_deploy({ monitor_id: ID, version: 3 });
    const result = await handlers.monitor_undeploy({ monitor_id: ID });
    expect(call(1)).toMatchObject({ path: `/api/workflows/${ID}/commits/`, method: 'POST', body: { version_description: 'Threshold change' } });
    expect(call(3)).toMatchObject({ path: `/api/workflows/${ID}/deployments/`, method: 'POST', body: { version: 3 } });
    expect(JSON.parse(result.content[0].text)).toEqual({ workflow_id: ID, is_enabled: false });
  });
  it('translates alert history pagination and preserves backend time-series semantics', async () => {
    const { handlers, call } = fixture();
    const window = { start_time: '2026-10-01', end_time: '2026-10-02' };
    await handlers.monitor_run_history({ monitor_id: ID, ...window, page: 3, page_size: 10 });
    await handlers.monitor_runs_time_series({ monitor_id: ID, ...window, time_tick: 'hour', version_id: 'version-3' });
    expect(call(1)).toEqual({ method: 'GET', path: `/clickhouse/workflows/${ID}/runs/list`, query: { ...window, limit: '10', offset: '20' }, body: undefined });
    expect(call(3)).toEqual({ method: 'GET', path: `/clickhouse/workflows/${ID}/runs/summary`, query: { ...window, time_tick: 'hour', version_id: 'version-3' }, body: undefined });
  });
});
