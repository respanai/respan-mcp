// lib/production/index.ts
//
// Production section: what is happening in the app right now. Every tool here
// only reads the caller's workspace.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthenticatedClient } from "../shared/client.js";
import { registerFeatureTools } from "./features.js";
import { registerLogTools } from "./logs.js";
import { registerMetricTools } from "./metrics.js";
import { registerTraceTools } from "./traces.js";

export function registerProductionTools(server: McpServer, client: AuthenticatedClient | null) {
  registerLogTools(server, client);
  registerTraceTools(server, client);
  registerMetricTools(server, client);
  registerFeatureTools(server, client);
}
