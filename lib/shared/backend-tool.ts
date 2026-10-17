// lib/shared/backend-tool.ts
//
// Tools whose base description and input schema come from the
// backend's customer tool catalog (lib/generated/backend-tools.json, exported
// by scripts/export_backend_tools.py), so this server and the in-product agent
// share wire contracts. Product tools may adapt names, descriptions and defaults.
// The HTTP call is written here, mirroring the
// backend executor of the same name.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AuthenticatedClient } from "./client.js";
import { requireClient } from "./client.js";
import { INTERNAL_RESPONSE_KEYS, budgetedJson, omitKeys, textResult } from "./tool-result.js";
import { toZodShape, type JsonSchema } from "../generated/schema-to-zod.js";
import catalog from "../generated/backend-tools.json" with { type: "json" };

export interface BackendToolContract {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
}

export const BACKEND_TOOLS: ReadonlyMap<string, BackendToolContract> = new Map(
  (catalog.tools as BackendToolContract[]).map((tool) => [tool.name, tool]),
);

const BACKEND_TOOL_BUDGET = { maxChars: 40_000, stringCaps: [2_000, 500, 200] };

export type BackendToolHandler = (
  client: AuthenticatedClient,
  args: Record<string, any>,
) => Promise<unknown>;

/** Listed descriptions keep their first paragraph, cut to this many characters. */
const DESCRIPTION_MAX_CHARS = 300;
/** Argument descriptions are cut to this many characters. */
const ARGUMENT_DESCRIPTION_MAX_CHARS = 100;
/** Arguments most tools share, described once in a few words. */
const SHARED_ARGUMENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  is_workspace_level: 'With workspace: aggregate every project of that workspace (OAuth).',
  workspace: 'Workspace UUID (unique_company_organization_id).',
  page: 'Page number, 1-based.',
  page_size: 'Rows per page.',
};

/** The uncut contract of every registered tool, for tool_search `select:`. */
export const FULL_CONTRACTS = new Map<string, Pick<BackendToolContract, 'description' | 'inputSchema'>>();

/** The first paragraph of `text`, cut at a sentence end within `maxChars`. */
export function compactText(text: string, maxChars: number): string {
  const paragraph = text.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ');
  if (paragraph.length <= maxChars) return paragraph;
  const cut = paragraph.slice(0, maxChars);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return sentenceEnd > maxChars / 2 ? cut.slice(0, sentenceEnd + 1) : `${cut.trimEnd()}…`;
}

function compactSchema(node: unknown, name?: string): unknown {
  if (Array.isArray(node)) return node.map((item) => compactSchema(item));
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([key, value]) => {
    if (key === 'properties' && value && typeof value === 'object') {
      return [key, Object.fromEntries(Object.entries(value).map(([prop, schema]) => [prop, compactSchema(schema, prop)]))];
    }
    if (key === 'description' && typeof value === 'string') {
      return [key, (name && SHARED_ARGUMENT_DESCRIPTIONS[name]) ?? compactText(value, ARGUMENT_DESCRIPTION_MAX_CHARS)];
    }
    return [key, compactSchema(value)];
  }));
}

/** A display title from the tool name: `log_list` → "Log list". */
export function toolTitle(name: string): string {
  const words = name.split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function registerBackendTool(
  server: McpServer,
  client: AuthenticatedClient | null,
  name: string,
  annotations: ToolAnnotations,
  handler: BackendToolHandler,
  contract?: BackendToolContract,
): void {
  const tool = contract ?? BACKEND_TOOLS.get(name);
  if (!tool) {
    // A rename in the backend must fail loudly rather than drop the tool.
    throw new Error(`registerBackendTool: '${name}' is not in lib/generated/backend-tools.json`);
  }
  FULL_CONTRACTS.set(name, { description: tool.description, inputSchema: tool.inputSchema });
  server.registerTool(
    name,
    {
      title: toolTitle(name),
      description: compactText(tool.description, DESCRIPTION_MAX_CHARS),
      inputSchema: toZodShape(compactSchema(tool.inputSchema) as JsonSchema),
      annotations,
    },
    async (args: Record<string, unknown>) => {
      const c = requireClient(client);
      const data = await handler(c, (args ?? {}) as Record<string, any>);
      return textResult(budgetedJson(omitKeys(data, INTERNAL_RESPONSE_KEYS), BACKEND_TOOL_BUDGET));
    },
  );
}

/**
 * The listed keys the caller set, dropping null and empty values, the way the
 * backend's `_body_from_args` builds a POST-for-filtering body.
 */
export function pickArgs(args: Record<string, any>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") picked[key] = value;
  }
  return picked;
}

/**
 * The listed keys the caller passed, values untouched, so an empty string can
 * clear a field (the backend's `_passed_args`).
 */
export function passedArgs(args: Record<string, any>, keys: readonly string[]): Record<string, unknown> {
  const passed: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in args && args[key] !== undefined) passed[key] = args[key];
  }
  return passed;
}
