// Checks the shape of every tool a client sees, on /mcp and /mcp/docs.
//
// Clients act on these properties, so a regression here breaks agents
// silently rather than failing a request: Claude Code truncates descriptions
// past 2,048 characters, clients drop tools whose input schema does not
// compile, and every byte of tools/list is paid by every session up front.
//
// The size, tool-name and untitled-tool checks compare against
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
import { createDocsServer } from '../lib/docs/tools.js';

const BASELINE_URL = new URL('./fixtures/tool-surface.baseline.json', import.meta.url);
const IS_UPDATING_BASELINE = process.env.UPDATE_SURFACE_BASELINE === '1';

/** Claude Code truncates tool descriptions past this length. */
const MAX_DESCRIPTION_CHARS = 2_048;
/**
 * Tools allowed past MAX_DESCRIPTION_CHARS. Empty: no tool on either surface
 * is over the limit. Add a name here only with a reason, and remove it once
 * its description is cut down or the tool is gone.
 */
const KNOWN_OVERLONG_DESCRIPTIONS = new Set<string>();
/** Claude's connector directory caps names at 64; lowercase snake_case is ours. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** tools/list may grow this much past the baseline before the check fails. */
const MAX_SURFACE_GROWTH = 1.1;

interface SurfaceBaseline {
  tools_list_chars: number;
  tool_names: string[];
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

/** Keyed by the baseline name; `route` is where the surface is served. */
const SURFACES: Record<string, { route: string; create: () => McpServer }> = {
  mcp: { route: '/mcp', create: () => createServer(null) },
  docs: { route: '/mcp/docs', create: createDocsServer },
};

/** Each surface is listed once and shared by every check below. */
const listedSurfaces = new Map<string, Promise<Tool[]>>();
function surfaceTools(surface: string): Promise<Tool[]> {
  let tools = listedSurfaces.get(surface);
  if (!tools) {
    tools = listTools(SURFACES[surface].create());
    listedSurfaces.set(surface, tools);
  }
  return tools;
}

function measure(tools: Tool[]): SurfaceBaseline {
  return {
    tools_list_chars: JSON.stringify({ tools }).length,
    tool_names: tools.map((tool) => tool.name).sort(),
    untitled_tools: tools
      .filter((tool) => !tool.title && !tool.annotations?.title)
      .map((tool) => tool.name)
      .sort(),
  };
}

function readBaselines(): Baselines {
  return JSON.parse(readFileSync(BASELINE_URL, 'utf8')) as Baselines;
}

const SURFACE_CASES = Object.entries(SURFACES).map(([surface, { route }]) => [route, surface]);

describe.each(SURFACE_CASES)('tool surface: %s', (route, surface) => {
  it('names every tool in lowercase snake_case of at most 64 characters', async () => {
    const tools = await surfaceTools(surface);
    expect(tools.length).toBeGreaterThan(0);
    const badNames = tools.map((tool) => tool.name).filter((name) => !TOOL_NAME_PATTERN.test(name));
    expect(badNames).toEqual([]);
  });

  it('keeps every description within what clients show', async () => {
    const tools = await surfaceTools(surface);
    for (const tool of tools) {
      expect(tool.description?.trim(), `${tool.name} has no description`).toBeTruthy();
      if (KNOWN_OVERLONG_DESCRIPTIONS.has(tool.name)) continue;
      expect(tool.description!.length, `${tool.name} description length`).toBeLessThanOrEqual(
        MAX_DESCRIPTION_CHARS,
      );
    }
  });

  it('gives every tool an input schema that compiles', async () => {
    const tools = await surfaceTools(surface);
    // Strict, so a misspelt keyword fails instead of being ignored. Formats
    // are annotations to clients, so they are not validated here.
    const ajv = new Ajv({
      strict: true,
      strictTypes: false,
      strictRequired: false,
      strictTuples: false,
      validateFormats: false,
      allErrors: true,
    });
    for (const tool of tools) {
      expect(tool.inputSchema.type, `${tool.name} inputSchema.type`).toBe('object');
      expect(() => ajv.compile(tool.inputSchema), `${tool.name} inputSchema`).not.toThrow();
    }
  });

  it('matches the baseline tool names, titles and tools/list size', async () => {
    const current = measure(await surfaceTools(surface));
    const baselines = readBaselines();
    const baseline = baselines[surface];
    expect(baseline, `no baseline for ${route}; run npm run surface:update`).toBeDefined();

    // Untitled tools may only go away: a new tool, or one that lost its title,
    // fails here even in update mode, so surface:update cannot accept it.
    const newlyUntitled = current.untitled_tools.filter((name) => !baseline.untitled_tools.includes(name));
    expect(newlyUntitled, 'these tools need a title').toEqual([]);

    if (IS_UPDATING_BASELINE) {
      baselines[surface] = current;
      writeFileSync(BASELINE_URL, `${JSON.stringify(baselines, null, 2)}\n`);
      return;
    }

    expect(
      current.tools_list_chars,
      `tools/list grew more than ${Math.round((MAX_SURFACE_GROWTH - 1) * 100)}% `
        + `(${baseline.tools_list_chars} -> ${current.tools_list_chars} chars); `
        + 'if intended, run npm run surface:update',
    ).toBeLessThanOrEqual(Math.floor(baseline.tools_list_chars * MAX_SURFACE_GROWTH));
    // Adding, removing or renaming a tool always shows up as a baseline change.
    expect(
      current.tool_names,
      `${route} tools changed; if intended, run npm run surface:update`,
    ).toEqual(baseline.tool_names);
    // A tool that gained a title leaves the list, so it cannot quietly lose it again.
    const nowTitled = baseline.untitled_tools.filter((name) => !current.untitled_tools.includes(name));
    expect(nowTitled, 'these tools now have a title; run npm run surface:update').toEqual([]);
  });
});

describe('known overlong descriptions', () => {
  it('lists only tools that still exist and are still too long', async () => {
    const surfaces = await Promise.all(Object.keys(SURFACES).map(surfaceTools));
    const tools = new Map(surfaces.flat().map((tool) => [tool.name, tool]));
    for (const name of KNOWN_OVERLONG_DESCRIPTIONS) {
      const length = tools.get(name)?.description?.length ?? 0;
      expect(length, `${name} is fixed or gone; remove it from KNOWN_OVERLONG_DESCRIPTIONS`).toBeGreaterThan(
        MAX_DESCRIPTION_CHARS,
      );
    }
  });
});
