// lib/production/threads.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthenticatedClient } from "../shared/client.js";
import { rawFetch, requireClient } from "../shared/client.js";
import {
  INTERNAL_RESPONSE_KEYS,
  READ_ONLY_WORKSPACE_TOOL,
  budgetedJson,
  omitKeys,
  readListPage,
  textResult,
  truncateStrings,
} from "../shared/tool-result.js";
import {
  environmentShape,
  pageShape,
  resolvePage,
  resolveTimeWindow,
  timeWindowShape,
  type BackendFilters,
} from "./params.js";

const THREAD_PAGE_SIZE_DEFAULT = 5;
const THREAD_PAGE_SIZE_MAX = 10;

export const THREAD_SORT_OPTIONS = [
  "-timestamp",
  "timestamp",
  "-total_cost",
  "-number_of_requests",
  "-average_latency",
] as const;

/**
 * Columns thread_list returns per conversation. The endpoint has answered
 * with both spellings of the totals (log_count/cost and
 * number_of_requests/total_cost), so both are kept when present.
 */
export const THREAD_LIST_FIELDS = [
  "thread_identifier",
  "timestamp",
  "environment",
  "customer_identifier",
  "log_count",
  "number_of_requests",
  "cost",
  "total_cost",
  "tokens",
  "total_tokens",
  "latency",
  "average_latency",
  "input",
  "output",
] as const;

const THREAD_PREVIEW_CHARS = 200;
const THREAD_BUDGET = { maxChars: 20_000, stringCaps: [200, 80] };

function projectThreadRow(row: unknown): Record<string, unknown> {
  const source = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of THREAD_LIST_FIELDS) {
    if (field in source) projected[field] = source[field];
  }
  return truncateStrings(projected, THREAD_PREVIEW_CHARS) as Record<string, unknown>;
}

export function registerThreadTools(server: McpServer, client: AuthenticatedClient | null) {
  server.registerTool(
    "thread_list",
    {
      title: "Find conversations",
      description: `Find conversations (threads): all requests that share one thread_identifier, such as a chat session with one of your users. Use it for "longest conversations today", "most expensive chats" or "conversations from user X".

Returns one page of conversations with their thread_identifier, request count, cost, tokens, latency, last activity time and a short preview of the messages. To read the messages, call log_list with the thread_identifier.

Defaults to the last 24 hours, newest first.`,
      inputSchema: {
        ...timeWindowShape,
        ...environmentShape,
        customer_identifier: z.string().optional().describe("Only conversations with this end user of your app."),
        min_requests: z.number().int().min(1).optional().describe("Only conversations with at least this many requests."),
        sort_by: z.enum(THREAD_SORT_OPTIONS).optional().describe("Sort order (default -timestamp, newest first). '-' means descending."),
        ...pageShape(THREAD_PAGE_SIZE_DEFAULT, THREAD_PAGE_SIZE_MAX),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async (args) => {
      const c = requireClient(client);
      const window = resolveTimeWindow(args);
      const { page, pageSize } = resolvePage(args, THREAD_PAGE_SIZE_DEFAULT, THREAD_PAGE_SIZE_MAX);

      const filters: BackendFilters = {};
      if (args.customer_identifier) {
        filters.customer_identifier = { operator: "", value: [args.customer_identifier] };
      }
      if (args.min_requests) {
        filters.number_of_requests = { operator: "gte", value: [args.min_requests] };
      }

      const result = await rawFetch(c, "/api/log_threads/", {
        query: {
          ...window,
          environment: args.environment,
          sort_by: args.sort_by ?? "-timestamp",
          page,
          page_size: pageSize,
        },
        body: Object.keys(filters).length > 0 ? { filters } : {},
      });

      const { rows, hasMore } = readListPage(result, pageSize);
      return textResult(budgetedJson({
        ...window,
        page,
        page_size: pageSize,
        has_more: hasMore,
        results: rows.map(projectThreadRow),
      }, THREAD_BUDGET));
    },
  );

  server.registerTool(
    "thread_get",
    {
      title: "Read conversation totals",
      description: `Read one conversation's totals by thread_identifier: number of requests, cost, tokens, latency, and when it was last active.

To read the conversation's messages, call log_list with this thread_identifier, then log_get for any request you want in full.`,
      inputSchema: {
        thread_identifier: z.string().describe("The conversation's thread_identifier, from thread_list or log_list."),
      },
      annotations: READ_ONLY_WORKSPACE_TOOL,
    },
    async ({ thread_identifier }) => {
      const c = requireClient(client);
      const result = await rawFetch(c, `/api/log_thread/${encodeURIComponent(thread_identifier)}/`, {
        method: "GET",
      });
      return textResult(budgetedJson(omitKeys(result, INTERNAL_RESPONSE_KEYS), THREAD_BUDGET));
    },
  );
}
