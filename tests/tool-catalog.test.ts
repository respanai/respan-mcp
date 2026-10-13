import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../lib/shared/mcp-handler.js';
import { applyToolCatalog, TOOL_CATEGORIES, TOOL_CATEGORY_META_KEY } from '../lib/shared/tool-catalog.js';
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
  it('classifies every registered platform tool without losing schemas or annotations', async () => {
    const tools = await list(createServer(null));
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(TOOL_CATEGORIES, tool.name).toContain(tool._meta?.[TOOL_CATEGORY_META_KEY]);
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const [name, category] of Object.entries({
      trace_get: 'traces', log_get: 'logs', behavior_grouped: 'behaviors',
      custom_behavior_create: 'behaviors', error_group_get: 'errors',
      monitor_create: 'monitors', monitor_update: 'monitors', notification_destination_list: 'monitors',
    })) expect(byName.get(name)?._meta?.[TOOL_CATEGORY_META_KEY]).toBe(category);
  });
  it('excludes retired resource families from the public product surface', async () => {
    const names = (await list(createServer(null))).map(t => t.name);
    expect(names.some(name => /^(automation|evaluator|grader|workflow|export_workflow|dataset|experiment)_/.test(name))).toBe(false);
    expect(TOOL_CATEGORIES).not.toContain('custom-behaviors');
    expect(TOOL_CATEGORIES).not.toContain('conversations');
    expect(names).not.toContain('thread_list');
    expect(names).not.toContain('thread_get');
  });
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
