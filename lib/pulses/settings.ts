import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBackendTool } from '../shared/backend-tool.js';
import { rawFetch, type AuthenticatedClient } from '../shared/client.js';
import { DESTRUCTIVE_TOOL } from '../shared/tool-policy.js';

export async function currentOrganization(client: AuthenticatedClient): Promise<Record<string, any>> {
  const result = await rawFetch(client, '/auth/current-organization/', { method: 'GET' });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Current project lookup returned an unexpected response.');
  return result as Record<string, any>;
}

// Two calls, as the backend executor makes them: the only write route takes
// the project UUID, which the caller's credential does not carry.
export function registerBehaviorSettings(server: McpServer, client: AuthenticatedClient | null) {
  registerBackendTool(server, client, 'behavior_disabled_set', DESTRUCTIVE_TOOL, async (c, args) => {
    const org = await currentOrganization(c);
    const id = org.unique_organization_id;
    if (typeof id !== 'string' || !id) throw new Error('Current project has no identifier; no settings were changed.');
    return rawFetch(c, `/user/organization/${encodeURIComponent(id)}/`, {
      method: 'PATCH', body: { disabled_span_behaviors: args.disabled_span_behaviors },
    });
  });
}
