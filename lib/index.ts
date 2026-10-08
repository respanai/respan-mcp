#!/usr/bin/env node
// Entry point for Respan MCP Server (stdio mode)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveAuthFromEnv, createClient } from "./shared/client.js";
import { registerProductionTools } from "./production/index.js";
import { registerPulseTools } from "./pulses/index.js";
import { registerPromptTools } from "./develop/prompts.js";
import { registerExperimentTools } from "./develop/experiments.js";
import { registerEvaluatorTools } from "./evaluate/evaluators.js";
import { registerDatasetTools } from "./evaluate/datasets.js";
import { registerEvaluationPipelineTools } from "./evaluate/pipelines.js";
import { registerWorkflowTools } from "./develop/workflows.js";
import { registerOrganizationTools } from "./account/organizations.js";
import { applyToolPolicy } from "./shared/tool-policy.js";
import { rewriteToolCallNames } from "./shared/tool-aliases.js";

async function main() {
  const auth = resolveAuthFromEnv();
  const client = auth ? createClient(auth, auth.baseUrl) : null;

  if (!auth) {
    console.error("No credentials found. Set RESPAN_API_KEY or run `respan login` to authenticate.");
    console.error("Only public tools will be available.");
  }

  const server = new McpServer({
    name: "respan",
    version: "1.0.0",
  });
  applyToolPolicy(server);

  registerProductionTools(server, client);
  registerPulseTools(server, client);
  registerPromptTools(server, client);
  registerExperimentTools(server, client);
  registerEvaluatorTools(server, client);
  registerDatasetTools(server, client);
  registerEvaluationPipelineTools(server, client);
  registerWorkflowTools(server, client);
  registerOrganizationTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Old tool names in tools/call still reach the renamed tools.
  const handleMessage = transport.onmessage;
  transport.onmessage = (message) => {
    rewriteToolCallNames(message);
    handleMessage?.(message);
  };

  console.error("Respan MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
