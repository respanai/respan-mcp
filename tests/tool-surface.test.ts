// Checks the shape of every tool a client sees, on /mcp and /mcp/docs.
//
// Clients act on these properties, so a regression here breaks agents
// silently rather than failing a request: Claude Code truncates descriptions
// past 2,048 characters, clients drop tools whose input schema does not
// compile, and every byte of tools/list is paid by every session up front.
//
// The size and untitled-tool checks compare against
// tests/fixtures/tool-surface.baseline.json. After an intended change, run
// `npm run surface:update` and commit the new baseline with the change.

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../lib/shared/mcp-handler.js';
import { registerDocTools } from '../lib/docs/tools.js';
import { applyToolPolicy } from '../lib/shared/tool-policy.js';

const BASELINE_URL = new URL('./fixtures/tool-surface.baseline.json', import.meta.url);
const IS_UPDATING_BASELINE = process.env.UPDATE_SURFACE_BASELINE === '1';

/** Claude Code truncates tool descriptions past this length. */
const MAX_DESCRIPTION_CHARS = 2_048;
/**
 * Tools already over MAX_DESCRIPTION_CHARS when this check landed. The list
 * may only shrink: a tool leaves it when its description is cut down or the
 * tool is replaced (the generic workflow_* tools are due to become typed
 * monitor_/automation_/report_ tools).
 */
const KNOWN_OVERLONG_DESCRIPTIONS = new Set(['workflow_create']);
/** Claude's connector directory caps names at 64; lowercase snake_case is ours. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** tools/list may grow this much past the baseline before the check fails. */
const MAX_SURFACE_GROWTH = 1.1;

interface SurfaceBaseline {
  tools_list_chars: number;
  tool_count: number;
  untitled_tools: string[];
}

type Baselines = Record<string, SurfaceBaseline>;

async function listTools(server: McpServer): Promise<Tool[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'tool-surface-test', version: '0.0.0' });
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

const SURFACES: Record<string, () => McpServer> = {
  mcp: () => createServer(null),
  docs: docsServer,
};

function measure(tools: Tool[]): SurfaceBaseline {
  return {
    tools_list_chars: JSON.stringify({ tools }).length,
    tool_count: tools.length,
    untitled_tools: tools
      .filter((tool) => !tool.title && !tool.annotations?.title)
      .map((tool) => tool.name)
      .sort(),
  };
}

function readBaselines(): Baselines {
  return JSON.parse(readFileSync(BASELINE_URL, 'utf8')) as Baselines;
}

describe.each(Object.keys(SURFACES))('tool surface: /%s', (surface) => {
  it('names every tool in lowercase snake_case of at most 64 characters', async () => {
    const tools = await listTools(SURFACES[surface]());
    expect(tools.length).toBeGreaterThan(0);
    const badNames = tools.map((tool) => tool.name).filter((name) => !TOOL_NAME_PATTERN.test(name));
    expect(badNames).toEqual([]);
  });

  it('keeps every description within what clients show', async () => {
    const tools = await listTools(SURFACES[surface]());
    for (const tool of tools) {
      expect(tool.description?.trim(), `${tool.name} has no description`).toBeTruthy();
      if (KNOWN_OVERLONG_DESCRIPTIONS.has(tool.name)) continue;
      expect(tool.description!.length, `${tool.name} description length`).toBeLessThanOrEqual(
        MAX_DESCRIPTION_CHARS,
      );
    }
  });

  it('gives every tool an input schema that compiles', async () => {
    const tools = await listTools(SURFACES[surface]());
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const tool of tools) {
      expect(tool.inputSchema.type, `${tool.name} inputSchema.type`).toBe('object');
      expect(() => ajv.compile(tool.inputSchema), `${tool.name} inputSchema`).not.toThrow();
    }
  });

  it('stays within the tools/list size and title baseline', async () => {
    const current = measure(await listTools(SURFACES[surface]()));

    if (IS_UPDATING_BASELINE) {
      const baselines = readBaselines();
      baselines[surface] = current;
      writeFileSync(BASELINE_URL, `${JSON.stringify(baselines, null, 2)}\n`);
      return;
    }

    const baseline = readBaselines()[surface];
    expect(baseline, `no baseline for /${surface}; run npm run surface:update`).toBeDefined();
    expect(
      current.tools_list_chars,
      `tools/list grew more than ${Math.round((MAX_SURFACE_GROWTH - 1) * 100)}% `
        + `(${baseline.tools_list_chars} -> ${current.tools_list_chars} chars); `
        + 'if intended, run npm run surface:update',
    ).toBeLessThanOrEqual(Math.floor(baseline.tools_list_chars * MAX_SURFACE_GROWTH));
    // Untitled tools may only go away: a new tool must ship with a title.
    const newlyUntitled = current.untitled_tools.filter((name) => !baseline.untitled_tools.includes(name));
    expect(newlyUntitled, 'new tools need a title').toEqual([]);
  });
});

describe('known overlong descriptions', () => {
  it('lists only tools that still exist and are still too long', async () => {
    const tools = new Map((await listTools(createServer(null))).map((tool) => [tool.name, tool]));
    for (const name of KNOWN_OVERLONG_DESCRIPTIONS) {
      const length = tools.get(name)?.description?.length ?? 0;
      expect(length, `${name} is fixed or gone; remove it from KNOWN_OVERLONG_DESCRIPTIONS`).toBeGreaterThan(
        MAX_DESCRIPTION_CHARS,
      );
    }
  });
});

describe('stdio entry point', () => {
  // lib/index.ts keeps its own copy of the registration list. Until it shares
  // createServer, make sure the two lists cannot drift apart.
  it('registers the same tool modules as /mcp', () => {
    const registrations = (path: string) =>
      new Set(
        [...readFileSync(new URL(path, import.meta.url), 'utf8').matchAll(/\b(register\w+Tools)\(server/g)]
          .map((match) => match[1]),
      );
    const http = registrations('../lib/shared/mcp-handler.ts');
    expect(http.size).toBeGreaterThan(0);
    expect(registrations('../lib/index.ts')).toEqual(http);
  });
});
