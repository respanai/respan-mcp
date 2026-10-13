import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveToolName, TOOL_ALIASES } from './tool-aliases.js';

/** Product names share backend executors; wire parameter names stay unchanged. */
export function productDescription(description: string): string {
  return description.replace(/\b[a-z][a-z0-9_]*\b/g, name => TOOL_ALIASES[name] ?? name);
}

export function applyProductVocabulary(server: McpServer): void {
  for (const method of ['tool', 'registerTool'] as const) {
    const original = server[method].bind(server);
    (server as any)[method] = function (name: string, ...args: unknown[]) {
      const registered = (original as any)(name, ...args);
      registered?.update({
        name: resolveToolName(name),
        description: productDescription(registered.description ?? ''),
      });
      return registered;
    };
  }
}
