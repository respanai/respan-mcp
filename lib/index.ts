#!/usr/bin/env node
// Entry point for Respan MCP Server (stdio mode)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveAuthFromEnv, createClient } from "./shared/client.js";
import { createServer } from "./shared/mcp-handler.js";
import { rewriteToolCallNames } from "./shared/tool-aliases.js";

async function main() {
  const auth = resolveAuthFromEnv();
  const client = auth ? createClient(auth, auth.baseUrl) : null;

  if (!auth) {
    console.error("No credentials found. Set RESPAN_API_KEY or run `respan login` to authenticate.");
    console.error("Only public tools will be available.");
  }

  const server = createServer(client);

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
