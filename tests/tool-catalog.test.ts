import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../lib/shared/mcp-handler.js';
import { applyToolCatalog, TOOL_CATEGORY_META_KEY } from '../lib/shared/tool-catalog.js';
import { registerDocTools } from '../lib/docs/tools.js';

async function list(server: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'catalog-test', version: '1' });
  try {
    await client.connect(a);
    return (await client.listTools()).tools;
  } finally { await client.close(); }
}

describe('shared tool discovery', () => {
  it('retains server enabled-tool filtering', async () => {
    const tools = await list(createServer(null, new Set(['trace_get', 'monitor_create'])));
    expect(tools.map((t) => t.name).sort()).toEqual(['monitor_create', 'trace_get']);
  });
  it('labels public docs search separately', async () => {
    const server = new McpServer({ name: 'docs-test', version: '1' });
    applyToolCatalog(server);
    registerDocTools(server);
    const tools = await list(server);
    expect(tools[0]._meta?.[TOOL_CATEGORY_META_KEY]).toBe('docs');
  });
});
