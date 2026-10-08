// lib/shared/backend-tool.ts
//
// Tools whose name, description and input schema come verbatim from the
// backend's customer tool catalog (lib/generated/backend-tools.json, exported
// by scripts/export_backend_tools.py), so this server and the in-product agent
// describe them identically. Only the HTTP call is written here, mirroring the
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

export function registerBackendTool(
  server: McpServer,
  client: AuthenticatedClient | null,
  name: string,
  annotations: ToolAnnotations,
  handler: BackendToolHandler,
): void {
  const tool = BACKEND_TOOLS.get(name);
  if (!tool) {
    // A rename in the backend must fail loudly rather than drop the tool.
    throw new Error(`registerBackendTool: '${name}' is not in lib/generated/backend-tools.json`);
  }
  server.registerTool(
    name,
    {
      description: tool.description,
      inputSchema: toZodShape(tool.inputSchema),
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
