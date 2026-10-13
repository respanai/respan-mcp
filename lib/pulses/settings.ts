import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BACKEND_TOOLS, registerBackendTool } from '../shared/backend-tool.js';
import { rawFetch, requireClient, type AuthenticatedClient } from '../shared/client.js';
import { READ_ONLY_WORKSPACE_TOOL, textResult } from '../shared/tool-result.js';
import { DESTRUCTIVE_TOOL } from '../shared/tool-policy.js';

export async function currentOrganization(client: AuthenticatedClient): Promise<Record<string, any>> {
  const result = await rawFetch(client, '/auth/current-organization/', { method: 'GET' });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Current workspace lookup returned an unexpected response.');
  return result as Record<string, any>;
}

export function registerBehaviorSettings(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool('behavior_settings_get', {
    title: 'Behavior detection settings',
    description: 'Read the current workspace disabled_span_behaviors list. Requires an OAuth session; API-key authentication cannot access the current-organization settings endpoint.',
    inputSchema: {}, annotations: READ_ONLY_WORKSPACE_TOOL,
  }, async () => {
    const org = await currentOrganization(requireClient(client));
    return textResult(JSON.stringify({ disabled_span_behaviors: org.disabled_span_behaviors ?? [] }));
  });
  const source = BACKEND_TOOLS.get('behavior_disabled_list_update')!;
  registerBackendTool(server, client, 'behavior_settings_update', DESTRUCTIVE_TOOL, async (c, args) => {
    const org = await currentOrganization(c);
    const id = org.unique_organization_id;
    if (typeof id !== 'string' || !id) throw new Error('Current workspace has no organization identifier; no settings were changed.');
    const result = await rawFetch(c, `/user/organization/${encodeURIComponent(id)}/`, {
      method: 'PATCH', body: { disabled_span_behaviors: args.disabled_span_behaviors },
    }) as Record<string, any>;
    return { disabled_span_behaviors: result?.disabled_span_behaviors ?? args.disabled_span_behaviors };
  }, { ...source, name: 'behavior_settings_update', description: 'Replace the current workspace disabled_span_behaviors list. Read behavior_settings_get first; [] clears the disabled list. Requires OAuth. The target workspace is resolved from the session; no caller-supplied workspace ID is accepted.' });
}
