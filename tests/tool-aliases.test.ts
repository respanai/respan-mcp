import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpHandler, createServer } from '../lib/shared/mcp-handler.js';
import { registerDocTools } from '../lib/docs/tools.js';
import { applyToolPolicy } from '../lib/shared/tool-policy.js';
import { TOOL_ALIASES, resolveToolName, rewriteToolCallNames } from '../lib/shared/tool-aliases.js';

async function toolNames(server: McpServer): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'alias-test', version: '0.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((tool) => tool.name);
}

async function allToolNames(): Promise<Set<string>> {
  const docs = new McpServer({ name: 'respan-docs', version: '1.0.0' });
  applyToolPolicy(docs);
  registerDocTools(docs);
  return new Set([...await toolNames(createServer(null)), ...await toolNames(docs)]);
}

class MockResponse {
  statusCode = 200;
  headers = new Map<string, string | string[]>();
  body: any;
  headersSent = false;
  setHeader(name: string, value: string | string[]) { this.headers.set(name.toLowerCase(), value); return this; }
  getHeader(name: string) { return this.headers.get(name.toLowerCase()); }
  status(code: number) { this.statusCode = code; return this; }
  json(body: unknown) { this.body = body; this.headersSent = true; return this; }
  send(body: unknown) { this.body = body; this.headersSent = true; return this; }
}

function rpcRequest(method: string, params: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: 'Bearer sk-respan-test-key',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
      ...headers,
    },
    body: { jsonrpc: '2.0', id: 1, method, params },
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

/** The JSON-RPC message in a buffered streamable-HTTP response. */
function rpcResult(response: MockResponse): any {
  const text = String(response.body);
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data ? data.slice('data: '.length) : text);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tool aliases', () => {
  it('points every old name at a tool that exists, and shadows none', async () => {
    const names = await allToolNames();
    for (const [oldName, newName] of Object.entries(TOOL_ALIASES)) {
      expect(names.has(newName), `${oldName} -> ${newName} is not registered`).toBe(true);
      expect(names.has(oldName), `${oldName} is still registered`).toBe(false);
    }
  });

  it('rewrites old names in tools/call, single and batched, and nothing else', () => {
    const single = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_traces', arguments: {} } };
    expect(rewriteToolCallNames(single)).toEqual(['list_traces']);
    expect(single.params.name).toBe('trace_list');

    const batch = [
      { method: 'tools/call', params: { name: 'get_log_detail' } },
      { method: 'tools/call', params: { name: 'trace_get' } },
      { method: 'tools/list', params: { name: 'list_logs' } },
    ];
    expect(rewriteToolCallNames(batch)).toEqual(['get_log_detail']);
    expect(batch.map((m) => m.params.name)).toEqual(['log_get', 'trace_get', 'list_logs']);

    expect(rewriteToolCallNames(undefined)).toEqual([]);
    expect(resolveToolName('not_a_tool')).toBe('not_a_tool');
  });

  it('accepts old names in the Respan-Enabled-Tools header', async () => {
    const handler = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');
    const response = new MockResponse();
    await handler(rpcRequest('tools/list', {}, { 'respan-enabled-tools': 'list_traces, get_trace_tree, behavior_list' }), response as any);
    expect(response.statusCode).toBe(200);
    const names = rpcResult(response).result.tools.map((tool: { name: string }) => tool.name).sort();
    expect(names).toEqual(['behavior_list', 'trace_get', 'trace_list']);
  });

  it('runs a tools/call that uses an old name', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ trace_unique_id: 'abc', span_tree: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const handler = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');
    const response = new MockResponse();
    await handler(rpcRequest('tools/call', { name: 'get_trace_tree', arguments: { trace_id: 'abc' } }), response as any);
    expect(response.statusCode).toBe(200);
    expect(rpcResult(response).result.isError).toBeFalsy();
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.respan.ai/api/traces/abc/');
  });
});
