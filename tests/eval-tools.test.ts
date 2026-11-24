// The eval tools send what the in-product agent's executors send: behavior
// scoring is the caller's choice, and dataset versions are created, listed and
// compared through their own routes.

import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BACKEND_ROUTES } from '../lib/shared/backend-routes.js';
import { buildRequest, registerRoutedTools } from '../lib/shared/backend-route.js';
import type { AuthenticatedClient } from '../lib/shared/client.js';

const BEHAVIOR_TOOLS = ['dataset_eval_run', 'experiment_create', 'experiment_update', 'experiment_validate'];

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
