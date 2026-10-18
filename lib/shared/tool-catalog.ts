import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveToolName } from './tool-aliases.js';
import { foldedGroupOf } from './tool-index.js';

/** Shared discovery metadata; names and schemas remain those of registered tools. */
export const TOOL_CATEGORY_META_KEY = 'respan/category';

/** The tool's folded group, else its resource: the first word of its name. */
export function toolCategory(name: string): string {
  name = resolveToolName(name);
  return foldedGroupOf(name) ?? name.split('_')[0];
}

/** Attach category metadata on every transport without changing schemas or hints. */
export function applyToolCatalog(server: McpServer): void {
  for (const method of ['tool', 'registerTool'] as const) {
    const original = server[method].bind(server);
    (server as any)[method] = function (name: string, ...args: unknown[]) {
      const registered = (original as any)(name, ...args);
      registered?.update({ _meta: {
        ...registered._meta,
        [TOOL_CATEGORY_META_KEY]: toolCategory(name),
      } });
      return registered;
    };
  }
}
