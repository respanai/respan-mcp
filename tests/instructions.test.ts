import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../lib/shared/mcp-handler.js';
import { SERVER_INSTRUCTIONS } from '../lib/shared/instructions.js';
import { PUBLISHED_TOOL_NAMES } from '../lib/shared/register-tools.js';
import { FOLDED_TOOL_GROUPS } from '../lib/shared/tool-index.js';

/** Claude Code truncates server instructions past this length. */
const MAX_INSTRUCTIONS_CHARS = 2_048;
/** Codex weighs the start of the instructions most. */
const MAX_FIRST_PARAGRAPH_CHARS = 512;
/** Every snake_case word; each one must be a registered tool or a known field. */
const SNAKE_CASE_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
/** Response and argument fields and folded group names the instructions name, which are not tools. */
const NON_TOOL_WORDS = new Set(['start_time', 'end_time', 'has_more', 'include_folded', ...Object.keys(FOLDED_TOOL_GROUPS)]);

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(null).connect(serverTransport);
  const client = new Client({ name: 'instructions-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('server instructions', () => {
  it('fit what clients read', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
    expect(SERVER_INSTRUCTIONS.split('\n\n')[0].length).toBeLessThanOrEqual(MAX_FIRST_PARAGRAPH_CHARS);
  });

  it('are sent in initialize', async () => {
    const client = await connect();
    try {
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    } finally {
      await client.close();
    }
  });

  it('name only tools the server serves', () => {
    const named = [...new Set(SERVER_INSTRUCTIONS.match(SNAKE_CASE_PATTERN) ?? [])]
      .filter((word) => !NON_TOOL_WORDS.has(word));
    expect(named.length).toBeGreaterThan(5);
    expect(named.filter((name) => !PUBLISHED_TOOL_NAMES.has(name))).toEqual([]);
  });

  it('are also set on the stdio server', () => {
    const stdio = readFileSync(new URL('../lib/index.ts', import.meta.url), 'utf8');
    const handler = readFileSync(new URL('../lib/shared/mcp-handler.ts', import.meta.url), 'utf8');
    expect(stdio).toMatch(/createServer\(/);
    expect(handler).toMatch(/\{\s*instructions:\s*SERVER_INSTRUCTIONS\s*\}/);
  });
});
