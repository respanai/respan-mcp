import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BACKEND_TOOLS, passedArgs, pickArgs, registerBackendTool } from '../shared/backend-tool.js';
import { rawFetch, type AuthenticatedClient } from '../shared/client.js';
import { ADDITIVE_WRITE_TOOL, DESTRUCTIVE_TOOL } from '../shared/tool-policy.js';
import { omitKeys, READ_ONLY_WORKSPACE_TOOL } from '../shared/tool-result.js';

const CONTENT_FIELDS = ['name', 'description', 'tasks', 'type', 'trigger_event_type', 'schedule_cron', 'is_starred'];
const EDIT_FIELDS = ['name', 'description', 'tasks', 'trigger_event_type', 'schedule_cron'];
const FAMILY_ID = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F-]{36}|[\w.]+-[\w.-]+)(?::\d+)?$/;

function path(id: string, suffix = ''): string {
  if (!FAMILY_ID.test(id)) throw new Error('monitor_id must be an ID from monitor_list, not a display name.');
  return `/api/workflows/${encodeURIComponent(id)}/${suffix}`;
}

function query(url: string, values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.size ? `${url}?${params}` : url;
}

function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Monitor lookup returned an unexpected response.');
  return value as Record<string, any>;
}

function assertMonitor(row: Record<string, any>): void {
  if (row.type !== 'monitors') throw new Error('This resource is not a monitor; nothing was changed.');
}

async function getMonitor(client: AuthenticatedClient, id: string, includeSecrets = false) {
  const row = record(await rawFetch(client, query(path(id), includeSecrets ? { is_including_secrets: true } : {}), { method: 'GET' }));
  assertMonitor(row);
  return row;
}

/** Mirrors backend patch_workflow_family: PATCH, then merge a complete draft on 409. */
async function updateMonitor(client: AuthenticatedClient, id: string, body: Record<string, unknown>) {
  try {
    return await rawFetch(client, path(id), { method: 'PATCH', body });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('409 ')) throw error;
  }
  const current = await getMonitor(client, id, true);
  const draft = { ...passedArgs(current, CONTENT_FIELDS), ...body };
  const result = record(await rawFetch(client, path(id, 'versions/'), { method: 'POST', body: draft }));
  return { ...result, is_forked_draft: true };
}

export function registerMonitorTools(server: McpServer, client: AuthenticatedClient | null): void {
  // Backend customer contracts are authoritative. Remove an instruction to use
  // automation_create, which is deliberately absent from this product surface.
  const secretKeys = new Set(['webhook_secret']);
  const register = (name: string, annotations: typeof READ_ONLY_WORKSPACE_TOOL, handler: Parameters<typeof registerBackendTool>[4]) => {
    const contract = BACKEND_TOOLS.get(name)!;
    registerBackendTool(server, client, name, annotations, async (c, args) => omitKeys(await handler(c, args), secretKeys), {
      ...contract,
      inputSchema: JSON.parse(JSON.stringify(contract.inputSchema).replace(/evaluator_list/g, 'an existing evaluation configuration')),
      description: contract.description.replace('To attach a grader, build an automation instead (automation_create).', 'Grading configuration is outside the monitor tool surface.'),
    });
  };

  register('monitor_list', READ_ONLY_WORKSPACE_TOOL, async (c, args) => {
    const filters: Record<string, unknown> = { type: { value: ['monitors'], operator: 'eq' } };
    if (args.name) filters.name = { value: args.name, operator: 'icontains' };
    return rawFetch(c, query('/api/workflows/list/', {
      page: args.page ?? 1, page_size: Math.min(args.page_size ?? 20, 50),
      sort_by: args.sort_by, is_including_public_workflows: args.is_including_public_workflows || undefined,
    }), { method: 'POST', body: { filters } });
  });
  register('monitor_get', READ_ONLY_WORKSPACE_TOOL, (c, args) => getMonitor(c, args.monitor_id));
  register('monitor_create', ADDITIVE_WRITE_TOOL, (c, args) => rawFetch(c, '/api/workflows/', {
    method: 'POST', body: { ...passedArgs(args, EDIT_FIELDS), type: 'monitors' },
  }));
  register('monitor_update', DESTRUCTIVE_TOOL, async (c, args) => {
    await getMonitor(c, args.monitor_id);
    const body = passedArgs(args, EDIT_FIELDS);
    if (!Object.keys(body).length) throw new Error('Provide at least one monitor field to update.');
    return updateMonitor(c, args.monitor_id, body);
  });
  register('monitor_delete', DESTRUCTIVE_TOOL, async (c, args) => {
    const current = await getMonitor(c, args.monitor_id);
    if (!current.name || args.user_confirmation !== current.name) throw new Error('user_confirmation must exactly match the current monitor name; nothing was deleted.');
    await rawFetch(c, path(args.monitor_id), { method: 'DELETE' });
    return { deleted: true, workflow_id: args.monitor_id, name: current.name };
  });
  register('monitor_version_list', READ_ONLY_WORKSPACE_TOOL, async (c, args) => {
    await getMonitor(c, args.monitor_id);
    return rawFetch(c, query(path(args.monitor_id, 'versions/'), {
      page: args.page ?? 1, page_size: Math.min(args.page_size ?? 20, 50),
    }), { method: 'GET' });
  });
  for (const [name, suffix, method, keys] of [
    ['monitor_commit', 'commits/', 'POST', ['version_description']],
    ['monitor_deploy', 'deployments/', 'POST', ['version']],
    ['monitor_undeploy', 'deployments/', 'DELETE', []],
  ] as const) {
    register(name, name === 'monitor_commit' ? ADDITIVE_WRITE_TOOL : DESTRUCTIVE_TOOL, async (c, args) => {
      await getMonitor(c, args.monitor_id);
      const result = await rawFetch(c, path(args.monitor_id, suffix), {
        method, ...(method === 'POST' ? { body: passedArgs(args, keys) } : {}),
      });
      return result ?? { workflow_id: args.monitor_id, is_enabled: false };
    });
  }
  for (const [name, suffix] of [
    ['monitor_run_history', 'runs/list'], ['monitor_runs_time_series', 'runs/summary'],
  ] as const) {
    register(name, READ_ONLY_WORKSPACE_TOOL, async (c, args) => {
      await getMonitor(c, args.monitor_id);
      const params = pickArgs(args, ['start_time', 'end_time']);
      if (name === 'monitor_run_history') {
        const size = Math.min(args.page_size ?? 20, 50);
        Object.assign(params, { limit: size, offset: ((args.page ?? 1) - 1) * size });
      } else Object.assign(params, pickArgs(args, ['time_tick', 'version_id']));
      // ClickHouse metrics routes have no trailing slash.
      return rawFetch(c, query(`/clickhouse/workflows/${encodeURIComponent(args.monitor_id)}/${suffix}`, params), { method: 'GET' });
    });
  }
  for (const name of ['notification_method_list', 'notification_method_get']) {
    register(name, READ_ONLY_WORKSPACE_TOOL, (c, args) => rawFetch(c,
      name === 'notification_method_list'
        ? query('/user/organization-notification-methods/', { page: args.page ?? 1, page_size: Math.min(args.page_size ?? 20, 50) })
        : `/user/organization-notification-methods/${encodeURIComponent(args.notification_method_id)}/`,
      { method: 'GET' },
    ));
  }
}
