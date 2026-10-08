import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../lib/shared/mcp-handler.js';
import { registerDocTools } from '../lib/docs/tools.js';
import { applyToolPolicy, HIDDEN_TOOLS, TOOL_ANNOTATIONS } from '../lib/shared/tool-policy.js';
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
  it('annotates every tool on /mcp and /mcp/docs with the three hints', async () => {
    const tools = [...await listTools(createServer(null)), ...await listTools(docsServer())];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(TOOL_ANNOTATIONS, `${tool.name} is missing from TOOL_ANNOTATIONS`).toHaveProperty(tool.name);
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.openWorldHint, tool.name).toBe('boolean');
    }
  });

  it('does not register the hidden tools', async () => {
    const names = (await listTools(createServer(null))).map((tool) => tool.name);
    for (const hidden of HIDDEN_TOOLS) {
      expect(names).not.toContain(hidden);
    }
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

  it('marks deletes and overwrites as destructive and reads as read-only', async () => {
    const tools = new Map((await listTools(createServer(null))).map((tool) => [tool.name, tool]));
    for (const name of ['delete_dataset', 'update_prompt', 'deploy_workflow', 'validate_workflow']) {
      expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    for (const name of ['list_traces', 'get_prompt_detail', 'list_datasets']) {
      expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(tools.get('create_prompt')?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('keeps the respan-enabled-tools filter working', async () => {
    const tools = await listTools(createServer(null, new Set(['list_traces', 'run_evaluator'])));
    expect(tools.map((tool) => tool.name)).toEqual(['list_traces']);
    expect(tools[0].annotations?.readOnlyHint).toBe(true);
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
