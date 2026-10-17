// lib/shared/register-tools.ts
//
// Every tool the respan server registers, shared by the stdio and HTTP entry
// points. Backend-catalog tools are routed (lib/shared/backend-routes.ts);
// the rest have no backend executor of their own.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthenticatedClient } from './client.js';
import { PUBLIC_TOOL_NAMES, registerRoutedTools } from './backend-route.js';
import { BACKEND_ROUTES } from './backend-routes.js';
import { registerProjectTools } from '../account/projects.js';
import { registerBehaviorSettings } from '../pulses/settings.js';
import { registerFilterSchemaTools } from '../production/filter-schema.js';

/** Tools registered outside the route table, and the index's own tools. */
const UNROUTED_TOOL_NAMES = ['log_filter_schema_get', 'behavior_disabled_set', 'project_list', 'project_switch', 'tool_search', 'tool_run'];

/** Every name this server can serve; tool descriptions may only point at these. */
export const PUBLISHED_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(BACKEND_ROUTES).map((name) => PUBLIC_TOOL_NAMES[name] ?? name),
  ...UNROUTED_TOOL_NAMES,
]);

export function registerRespanTools(server: McpServer, client: AuthenticatedClient | null): void {
  registerRoutedTools(server, client, BACKEND_ROUTES, PUBLISHED_TOOL_NAMES);
  registerFilterSchemaTools(server, client);
  registerBehaviorSettings(server, client);
  registerProjectTools(server, client);
}
