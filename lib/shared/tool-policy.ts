// lib/shared/tool-policy.ts
//
// One table of MCP tool annotations for every tool registered through the
// legacy `server.tool(...)` API, so each tool tells clients whether it only
// reads, changes data, or deletes/overwrites it. ChatGPT plugin review
// requires readOnlyHint, destructiveHint and openWorldHint on every tool, and
// ChatGPT asks the user to confirm calls that are not read-only.
//
// Tools registered with `registerTool(...)` (the backend-catalog tools)
// declare their own annotations and pass through untouched.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { READ_ONLY_WORKSPACE_TOOL } from "./tool-result.js";

const READ = READ_ONLY_WORKSPACE_TOOL;

/** Reads public Respan documentation. */
const READ_PUBLIC: ToolAnnotations = { ...READ, openWorldHint: true };

/** Adds something new to the workspace without changing what exists. */
export const ADDITIVE_WRITE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const WRITE = ADDITIVE_WRITE_TOOL;

/** Deletes or overwrites data, or changes what runs in production. */
export const DESTRUCTIVE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const DESTRUCTIVE = DESTRUCTIVE_TOOL;

export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = {
  // Account
  project_list: READ,
  project_switch: WRITE,

  // Docs
  docs_search: READ_PUBLIC,
}

const unannotatedToolNames = new Set<string>();

/** Tools registered through `server.tool` that have no TOOL_ANNOTATIONS entry. */
export function unannotatedTools(): string[] {
  return [...unannotatedToolNames].sort();
}

/**
 * Wraps `server.tool` so every tool registered afterwards carries its
 * annotations from TOOL_ANNOTATIONS. A tool missing from the table is treated
 * as destructive, so a client asks before running it, and is reported by
 * unannotatedTools() so tests/tool-policy.test.ts fails until it is added.
 */
export function applyToolPolicy(server: McpServer): void {
  const originalTool = server.tool.bind(server);
  (server as any).tool = function (name: string) {
    if (!(name in TOOL_ANNOTATIONS)) unannotatedToolNames.add(name);
    const registered = originalTool.apply(server, arguments as any);
    registered?.update({ annotations: TOOL_ANNOTATIONS[name] ?? DESTRUCTIVE });
    return registered;
  };
}

const hiddenWriteTools = new WeakMap<McpServer, Set<string>>();

/**
 * For a read-only session: removes every registered tool whose final
 * annotations do not say readOnlyHint: true, and records its name. A tool
 * with readOnlyHint false or no annotation at all counts as a write, so a new
 * tool stays hidden from read-only sessions until it is marked read-only on
 * purpose. Call it after every tool is registered, so it sees each tool's final
 * annotations (after applyToolPolicy), whichever API registered it.
 */
export function removeWriteTools(server: McpServer): void {
  const hidden = new Set<string>();
  hiddenWriteTools.set(server, hidden);
  // The SDK keeps registered tools by name and has no public way to list them.
  const registered = (server as unknown as {
    _registeredTools: Record<string, { annotations?: ToolAnnotations }>;
  })._registeredTools;
  for (const [name, tool] of Object.entries(registered)) {
    if (tool.annotations?.readOnlyHint === true) continue;
    hidden.add(name);
    delete registered[name];
  }
}

/** Tools removeWriteTools took off `server`; empty when it was not applied. */
export function hiddenWriteToolsOf(server: McpServer): ReadonlySet<string> {
  return hiddenWriteTools.get(server) ?? new Set();
}
