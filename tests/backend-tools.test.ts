import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPulseTools } from '../lib/pulses/index.js';
import { registerPromptTools } from '../lib/develop/prompts.js';
import { createServer } from '../lib/shared/mcp-handler.js';
import { BACKEND_TOOLS } from '../lib/shared/backend-tool.js';
import type { AuthenticatedClient } from '../lib/shared/client.js';

type Handler = (args: any) => Promise<any>;

function capture(register: (server: McpServer, client: AuthenticatedClient | null) => void, client: AuthenticatedClient | null) {
  const tools: Record<string, { config: any; handler: Handler }> = {};
  const server = {
    registerTool(name: string, config: any, handler: Handler) { tools[name] = { config, handler }; },
    tool() {},
  } as unknown as McpServer;
  register(server, client);
  return tools;
}

/** A client whose fetch answers each call from `responses` in order. */
function fakeClient(responses: Array<{ status?: number; body: unknown }> = [{ body: {} }]) {
  let index = 0;
  const fetchMock = vi.fn(async () => {
    const { status = 200, body } = responses[Math.min(index++, responses.length - 1)];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  const client = {
    client: {},
    auth: 'Bearer test',
    baseUrl: 'https://api.example.invalid',
    fetch: fetchMock,
  } as unknown as AuthenticatedClient;
  const call = (i = 0) => {
    const [url, init] = (fetchMock.mock.calls[i] as unknown) as [string, RequestInit];
    const parsed = new URL(url);
    return {
      method: init.method,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
  };
  return { client, fetchMock, call };
}

describe('backend-catalog tools', () => {
  it('use the backend description verbatim', () => {
    const tools = capture(registerPulseTools, null);
    expect(Object.keys(tools).length).toBe(15);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.config.description).toBe(BACKEND_TOOLS.get(name)!.description);
    }
  });

  it('never point at a tool this server lacks', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(null);
    await server.connect(serverTransport);
    const mcp = new Client({ name: 'catalog-test', version: '0.0.0' });
    await mcp.connect(clientTransport);
    const tools = (await mcp.listTools()).tools;
    await mcp.close();
    const registered = new Set(tools.map((tool) => tool.name));
    // Any tool name from the backend vocabulary that a description mentions
    // must exist here, whether the description is ours or the backend's.
    for (const tool of tools) {
      for (const other of BACKEND_TOOLS.keys()) {
        if (other !== tool.name && new RegExp(`\\b${other}\\b`).test(tool.description ?? '')) {
          expect(registered.has(other), `${tool.name}'s description mentions ${other}, which is not registered`).toBe(true);
        }
      }
    }
  });
});

describe('behavior tools', () => {
  it('post analytics reads with only the keys each endpoint honors', async () => {
    const { client, call } = fakeClient();
    const tools = capture(registerPulseTools, client);
    await tools.behavior_grouped.handler({
      behavior: 'refusal', group_by: 'model', limit: 5, start_time: '2026-10-01T00:00:00Z', page: 2,
    });
    expect(call()).toEqual({
      method: 'POST',
      path: '/api/pulses/behaviors/grouped/',
      query: {},
      body: { start_time: '2026-10-01T00:00:00Z', behavior: 'refusal', group_by: 'model', limit: 5 },
    });
  });

  it('reads, updates and deletes one custom behavior by its escaped id', async () => {
    const { client, call } = fakeClient();
    const tools = capture(registerPulseTools, client);
    await tools.custom_behavior_get.handler({ behavior_id: 'a/b' });
    await tools.custom_behavior_update.handler({ behavior_id: 'a/b', name: '' });
    await tools.custom_behavior_delete.handler({ behavior_id: 'a/b' });
    expect(call(0)).toMatchObject({ method: 'GET', path: '/api/pulses/behaviors/custom/a%2Fb/' });
    // An empty name is passed through: it clears the field.
    expect(call(1)).toMatchObject({ method: 'PATCH', body: { name: '' } });
    expect(call(2)).toMatchObject({ method: 'DELETE', path: '/api/pulses/behaviors/custom/a%2Fb/' });
  });

  it('analyzes one definition or a batch on the matching endpoint', async () => {
    const { client, call } = fakeClient();
    const tools = capture(registerPulseTools, client);
    await tools.custom_behavior_analyze.handler({ description: 'The agent refuses.' });
    await tools.custom_behavior_analyze.handler({ descriptions: ['a', 'b'] });
    expect(call(0)).toMatchObject({ path: '/api/pulses/behaviors/custom/analyze-definition/', body: { description: 'The agent refuses.' } });
    expect(call(1)).toMatchObject({ path: '/api/pulses/behaviors/custom/analyze-definitions/', body: { descriptions: ['a', 'b'] } });
  });
});

describe('error tools', () => {
  it('rejects a malformed fingerprint before calling the backend', async () => {
    const { client, fetchMock } = fakeClient();
    const tools = capture(registerPulseTools, client);
    await expect(tools.pulse_error_group_get.handler({ fingerprint: '../x' })).rejects.toThrow(/Invalid fingerprint/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pages incidents on the query string and filters in the body', async () => {
    const { client, call } = fakeClient();
    const tools = capture(registerPulseTools, client);
    await tools.pulse_incidents_list.handler({ state: 'ongoing', page: 2, page_size: 10 });
    expect(call()).toEqual({
      method: 'POST',
      path: '/api/pulses/incidents/',
      query: { page: '2', page_size: '10' },
      body: { state: 'ongoing' },
    });
  });
});

describe('prompt_deploy', () => {
  it('deploys a committed version directly', async () => {
    const { client, call, fetchMock } = fakeClient([{ body: { deployed: true } }]);
    const tools = capture(registerPromptTools, client);
    await tools.prompt_deploy.handler({ prompt_id: 'p1', version: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call()).toMatchObject({ method: 'POST', path: '/api/prompts/p1/deployments/', body: { version: 3 } });
  });

  it('commits the current draft first, then deploys it', async () => {
    const { client, call } = fakeClient([
      { status: 400, body: { detail: 'Cannot deploy a draft. Commit it first.' } },
      { body: { current_version: { version: 4 } } },
      { body: { version: 4 } },
      { body: { deployed: true } },
    ]);
    const tools = capture(registerPromptTools, client);
    const result = JSON.parse((await tools.prompt_deploy.handler({ prompt_id: 'p1', version: 4 })).content[0].text);
    expect([call(0), call(1), call(2), call(3)].map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/prompts/p1/deployments/',
      'GET /api/prompts/p1/',
      'POST /api/prompts/p1/commits/',
      'POST /api/prompts/p1/deployments/',
    ]);
    expect(result).toMatchObject({ auto_committed: true, version: 4 });
  });

  it('refuses to deploy a draft that is not the current one', async () => {
    const { client } = fakeClient([
      { status: 400, body: { detail: 'Cannot deploy a draft.' } },
      { body: { current_version: { version: 5 } } },
    ]);
    const tools = capture(registerPromptTools, client);
    await expect(tools.prompt_deploy.handler({ prompt_id: 'p1', version: 4 })).rejects.toThrow(/not the current draft/);
  });
});
