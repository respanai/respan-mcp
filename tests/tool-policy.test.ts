import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../lib/shared/mcp-handler.js';
import { registerDocTools } from '../lib/docs/tools.js';
import { applyToolPolicy, TOOL_ANNOTATIONS, unannotatedTools } from '../lib/shared/tool-policy.js';
import handleChallenge from '../api/well-known/openai-apps-challenge.js';

async function listTools(server: McpServer): Promise<Tool[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tool-policy-test', version: '0.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

function docsServer(): McpServer {
  const server = new McpServer({ name: 'respan-docs', version: '1.0.0' });
  applyToolPolicy(server);
  registerDocTools(server);
  return server;
}

describe('tool policy', () => {
  it('gives every tool on /mcp and /mcp/docs all three hints', async () => {
    const tools = [...await listTools(createServer(null)), ...await listTools(docsServer())];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe('boolean');
    }
    // server.tool registrations must come from the table, not the fallback.
    expect(unannotatedTools()).toEqual([]);
  });

  it('has no table entries for tools that no longer exist', async () => {
    const names = new Set([
      ...(await listTools(createServer(null))).map((tool) => tool.name),
      ...(await listTools(docsServer())).map((tool) => tool.name),
    ]);
    for (const name of Object.keys(TOOL_ANNOTATIONS)) {
      expect(names.has(name), `${name} is in TOOL_ANNOTATIONS but not registered`).toBe(true);
    }
  });

  it('no longer lists the removed broken tools', async () => {
    const names = (await listTools(createServer(null))).map((tool) => tool.name);
    expect(names).not.toContain('run_evaluator');
    expect(names).not.toContain('deploy_prompt_version');
  });

  it('marks deletes, overwrites and deploys as destructive and reads as read-only', async () => {
    const tools = new Map((await listTools(createServer(null))).map((tool) => [tool.name, tool]));
    for (const name of [
      'dataset_delete', 'prompt_update', 'workflow_deploy', 'workflow_validate',
      'prompt_deploy', 'custom_behavior_delete', 'custom_behavior_update',
    ]) {
      expect(tools.get(name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    for (const name of [
      'trace_list', 'prompt_get', 'dataset_list', 'behavior_list', 'pulse_error_groups_list',
    ]) {
      expect(tools.get(name)?.annotations, name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    for (const name of ['prompt_create', 'prompt_commit', 'custom_behavior_create']) {
      expect(tools.get(name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it('keeps the respan-enabled-tools filter working', async () => {
    const tools = await listTools(createServer(null, new Set(['trace_list', 'behavior_list'])));
    expect(tools.map((tool) => tool.name).sort()).toEqual(['behavior_list', 'trace_list']);
  });
});

describe('openai-apps-challenge', () => {
  const original = process.env.OPENAI_APPS_CHALLENGE_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_APPS_CHALLENGE_TOKEN;
    else process.env.OPENAI_APPS_CHALLENGE_TOKEN = original;
  });

  function call() {
    const response = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: '' as unknown,
      setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
      status(code: number) { this.statusCode = code; return this; },
      send(body: unknown) { this.body = body; return this; },
    };
    handleChallenge({} as any, response as any);
    return response;
  }

  it('returns the token as plain text', () => {
    process.env.OPENAI_APPS_CHALLENGE_TOKEN = ' token-123\n';
    const response = call();
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('token-123');
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('is a 404 until the token is configured', () => {
    delete process.env.OPENAI_APPS_CHALLENGE_TOKEN;
    expect(call().statusCode).toBe(404);
  });
});
