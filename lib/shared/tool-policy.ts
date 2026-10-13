// lib/shared/tool-policy.ts
//
// One table of MCP tool annotations for every tool registered through the
// legacy `server.tool(...)` API, so each tool tells clients whether it only
// reads, changes data, or deletes/overwrites it. ChatGPT plugin review
// requires readOnlyHint, destructiveHint and openWorldHint on every tool, and
// ChatGPT asks the user to confirm calls that are not read-only.
//
// Tools registered with `registerTool(...)` (lib/production, lib/pulses and the
// backend-catalog tools) declare their own annotations and pass through
// untouched.

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
  // Prompts (prompt_commit and prompt_deploy carry their own)
  prompt_list: READ,
  prompt_get: READ,
  prompt_versions_list: READ,
  prompt_version_get: READ,
  prompt_create: WRITE,
  prompt_draft_init: WRITE,
  prompt_update: DESTRUCTIVE,
  prompt_version_update: DESTRUCTIVE,

  // Account
  org_list: READ,
  org_switch: WRITE,

  // Docs
  docs_search: READ_PUBLIC,
};

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
