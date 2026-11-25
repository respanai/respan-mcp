// The eval tools send what the in-product agent's executors send: behavior
// scoring is the caller's choice, and dataset versions are created, listed and
// compared through their own routes.

import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BACKEND_ROUTES } from '../lib/shared/backend-routes.js';
import { buildRequest, registerRoutedTools } from '../lib/shared/backend-route.js';
import { BACKEND_TOOLS } from '../lib/shared/backend-tool.js';
import type { AuthenticatedClient } from '../lib/shared/client.js';

const BEHAVIOR_TOOLS = ['dataset_eval_run'];

describe('behavior scoring', () => {
  it.each(BEHAVIOR_TOOLS)('%s forwards is_scoring_behaviors and behavior_keys as given', (name) => {
    const args = { dataset_id: 'ds', experiment_id: 'exp', workflow: [], is_scoring_behaviors: true, behavior_keys: ['hallucination'] };
    const { body } = buildRequest(BACKEND_ROUTES[name], args);
    expect(body).toMatchObject({ is_scoring_behaviors: true, behavior_keys: ['hallucination'] });
  });

  it.each(BEHAVIOR_TOOLS)('%s leaves is_scoring_behaviors to the backend when omitted', (name) => {
    const { body } = buildRequest(BACKEND_ROUTES[name], { dataset_id: 'ds', experiment_id: 'exp', workflow: [] });
    expect(body).not.toHaveProperty('is_scoring_behaviors');
  });
});

describe('dataset versions', () => {
  it('creates a version with a workflow and behavior settings', () => {
    const args = {
      dataset_id: 'ds',
      workflow: [{ type: 'completion', config: { model: 'gpt-4o-mini' } }],
      name: 'v2',
      behavior_settings: [{ key: 'hallucination', weight: 1 }],
      sample_size: 3,
    };
    expect(buildRequest(BACKEND_ROUTES.dataset_version_create, args)).toEqual({
      method: 'POST',
      path: '/api/datasets/ds/versions/',
      query: {},
      body: { workflow: args.workflow, name: 'v2', behavior_settings: args.behavior_settings, sample_size: 3 },
    });
  });

  it('lists versions', () => {
    expect(buildRequest(BACKEND_ROUTES.dataset_version_list, { dataset_id: 'ds', page: 2 }))
      .toMatchObject({ method: 'GET', path: '/api/datasets/ds/versions/', query: { page: 2 } });
  });

  it('compares versions, joining version_ids as the agent does', () => {
    const args = { dataset_id: 'ds', version_ids: ['a', 'b'], baseline_version_id: 'a' };
    expect(buildRequest(BACKEND_ROUTES.dataset_version_comparison_get, args)).toMatchObject({
      method: 'GET',
      path: '/api/datasets/ds/versions/comparison/',
      query: { version_ids: 'a,b', baseline_version_id: 'a' },
    });
  });
});

describe('dataset tools the eval flow needs', () => {
  it('sends row_filter and sort to the comparison', () => {
    const args = { dataset_id: 'ds', row_filter: 'edited', sort: 'score_delta' };
    expect(buildRequest(BACKEND_ROUTES.dataset_version_comparison_get, args).query)
      .toMatchObject({ row_filter: 'edited', sort: 'score_delta' });
  });

  it('asks for one row when is_summary_only is set, and never sends the flag', () => {
    const { query } = buildRequest(BACKEND_ROUTES.dataset_version_comparison_get, { dataset_id: 'ds', is_summary_only: true, page_size: 50 });
    expect(query).toEqual({ page_size: 1 });
    expect(buildRequest(BACKEND_ROUTES.dataset_version_comparison_get, { dataset_id: 'ds', is_summary_only: false, page_size: 50 }).query)
      .toEqual({ page_size: 50 });
  });

  it('saves behavior_settings on dataset_update', () => {
    const behavior_settings = [{ behavior_key: 'task_complete', weight: 1 }];
    expect(buildRequest(BACKEND_ROUTES.dataset_update, { dataset_id: 'ds', behavior_settings }).body)
      .toEqual({ behavior_settings });
  });

  it('reads one version', () => {
    expect(buildRequest(BACKEND_ROUTES.dataset_version_get, { dataset_id: 'ds', version_id: 'v2' }))
      .toMatchObject({ method: 'GET', path: '/api/datasets/ds/versions/v2/' });
  });

  it('estimates a run with a comma list of models', () => {
    expect(buildRequest(BACKEND_ROUTES.dataset_version_estimate, { dataset_id: 'ds', models: ['a', 'b'], sample_size: 3 }))
      .toMatchObject({ method: 'GET', path: '/api/datasets/ds/versions/estimate/', query: { models: 'a,b', sample_size: 3 } });
  });

  it('cancels a run as the agent does', () => {
    expect(buildRequest(BACKEND_ROUTES.dataset_version_cancel, { dataset_id: 'v2' }))
      .toMatchObject({ method: 'PATCH', path: '/api/datasets/v2/run/', body: { status: 'stopped' } });
    expect(BACKEND_ROUTES.dataset_version_cancel.destructive).toBe(true);
  });

  it('records a person\'s verdict on one row behavior, escaping the row id', () => {
    expect(buildRequest(BACKEND_ROUTES.dataset_log_verdict_update, { dataset_id: 'v2', unique_id: 'row/1', behavior_key: 'task_complete', prob: 0 }))
      .toEqual({ method: 'PATCH', path: '/api/datasets/v2/logs/row%2F1/behaviors/task_complete/', query: {}, body: { prob: 0 } });
    expect(BACKEND_TOOLS.get('dataset_log_verdict_update')?.readOnly).toBe(false);
  });

  it('tries a behavior definition on one row', () => {
    expect(buildRequest(BACKEND_ROUTES.dataset_behavior_try, { dataset_id: 'ds', definition: 'd', row_id: 'r' }))
      .toMatchObject({ method: 'POST', path: '/api/datasets/ds/behaviors/try/', body: { definition: 'd', row_id: 'r' } });
  });

  it('drops the rows only from a summary-only comparison', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ versions: [{ id: 'v' }], results: [{ match_id: 'm' }], total_count: 4 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const client = { auth: 'Bearer t', baseUrl: 'https://api.test', fetch: fetchMock } as unknown as AuthenticatedClient;
    const server = new McpServer({ name: 'eval-tools-test', version: '0.0.0' });
    const routes = { dataset_version_comparison_get: BACKEND_ROUTES.dataset_version_comparison_get };
    registerRoutedTools(server, client, routes, new Set(Object.keys(routes)));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'eval-tools-test', version: '0.0.0' });
    await mcp.connect(clientTransport);
    const call = async (is_summary_only: boolean) => JSON.parse(((await mcp.callTool({
      name: 'dataset_version_comparison_get', arguments: { dataset_id: 'ds', is_summary_only },
    })).content as { type: string; text: string }[])[0].text);
    const summary = await call(true);
    const full = await call(false);
    await mcp.close();
    expect(summary).toEqual({ versions: [{ id: 'v' }], total_count: 4 });
    expect(full.results).toEqual([{ match_id: 'm' }]);
  });
});

describe('dataset_log_list', () => {
  async function callDatasetLogList(args: Record<string, unknown>, rows: unknown[]) {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ results: rows }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const client = { auth: 'Bearer t', baseUrl: 'https://api.test', fetch: fetchMock } as unknown as AuthenticatedClient;
    const server = new McpServer({ name: 'eval-tools-test', version: '0.0.0' });
    const routes = { dataset_log_list: BACKEND_ROUTES.dataset_log_list };
    registerRoutedTools(server, client, routes, new Set(Object.keys(routes)));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'eval-tools-test', version: '0.0.0' });
    await mcp.connect(clientTransport);
    const result = await mcp.callTool({ name: 'dataset_log_list', arguments: args });
    await mcp.close();
    const [url] = fetchMock.mock.calls[0];
    const text = (result.content as { type: string; text: string }[])[0].text;
    return { url: new URL(String(url)), data: JSON.parse(text) };
  }

  it('sends include_fields as a comma list and cuts values to preview_length', async () => {
    const { url, data } = await callDatasetLogList(
      { dataset_id: 'ds', include_fields: ['unique_id', 'input'], preview_length: 5 },
      [{ unique_id: 'abc', input: 'a long input value '.repeat(10) }],
    );
    expect(url.pathname).toBe('/api/datasets/ds/logs/list/');
    expect(url.searchParams.get('include_fields')).toBe('unique_id,input');
    expect(url.searchParams.has('preview_length')).toBe(false);
    expect(data.results[0].unique_id).toBe('abc');
    expect(data.results[0].input).toBe('a lon…[truncated 185 chars]');
  });

  it('returns full values without preview_length', async () => {
    const { data } = await callDatasetLogList({ dataset_id: 'ds' }, [{ input: 'a long input value' }]);
    expect(data.results[0].input).toBe('a long input value');
  });
});

// The backend's WorkflowVersionType values. An unknown `type` query matches
// nothing, and no `type` lists every kind of workflow.
const WORKFLOW_TYPES = ['automations', 'monitors', 'evaluators', 'reports', 'exports', 'ingests'];
const WORKFLOW_LIST_TOOLS = Object.entries(BACKEND_ROUTES).filter(([, route]) =>
  route.requests.some((request) => request.path === '/api/workflows/list/'));

describe('workflow lists', () => {
  it('finds the four workflow list routes', () => {
    expect(WORKFLOW_LIST_TOOLS.map(([name]) => name).sort()).toEqual(['automation_list', 'evaluator_list', 'monitor_list', 'report_list']);
  });

  it.each(WORKFLOW_LIST_TOOLS)('%s pins one real workflow type', (name, route) => {
    const { query } = buildRequest(route, {});
    expect(WORKFLOW_TYPES).toContain(query.type);
    expect(query.type).toBe(`${name.replace(/_list$/, '')}s`);
  });
});

// Legacy Experiments are read-only (BE-12): the customer-facing agent never loads
// their writes, so this server neither lists nor routes them.
const LEGACY_EXPERIMENT_WRITES = ['experiment_create', 'experiment_delete', 'experiment_draft_create', 'experiment_run', 'experiment_update', 'experiment_validate'];

describe('legacy experiments', () => {
  it.each(LEGACY_EXPERIMENT_WRITES)('%s is neither in the catalog nor routed', (name) => {
    expect(BACKEND_TOOLS.has(name)).toBe(false);
    expect(BACKEND_ROUTES).not.toHaveProperty(name);
  });

  it('keeps the read tools', () => {
    for (const name of ['experiment_list', 'experiment_get', 'experiment_log_list', 'experiment_log_summary']) {
      expect(BACKEND_TOOLS.has(name)).toBe(true);
    }
  });
});
