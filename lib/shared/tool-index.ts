// lib/shared/tool-index.ts
//
// tools/list shows a few everyday tools plus tool_search and tool_run; every
// other registered tool is found with tool_search and called with tool_run (or
// by name, for clients that call unlisted tools). The ranking, synonyms and
// folded groups mirror the backend admin MCP (utils/mcp/tool_groups.py and
// utils/constants/mcp_tool_group_constants.py in respan-backend). This server
// is stateless, so search cannot add tools to a session's list the way the
// admin server does: it returns their schemas instead.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolveToolName } from './tool-aliases.js';
import { hiddenWriteToolsOf } from './tool-policy.js';
import { FULL_CONTRACTS, compactText } from './backend-tool.js';
import { READ_ONLY_WORKSPACE_TOOL } from './tool-result.js';

export const TOOL_SEARCH_NAME = 'tool_search';
export const TOOL_RUN_NAME = 'tool_run';

/** Listed at connect besides tool_search and tool_run. */
export const EAGER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'log_list',
  'log_get',
  'log_summary',
  'trace_list',
  'trace_get',
  'metric_summary',
  'metric_timeseries',
  'error_group_list',
  'behavior_summary',
  'prompt_list',
]);

/** Second-line groups: plain search skips them; include_folded=true searches them. */
export const FOLDED_TOOL_GROUPS: Readonly<Record<string, string>> = {
  automation: 'Automations (online eval pipelines): versions, deploy, run history, eval scores.',
  report: 'Scheduled report digests: versions, deploy, delivery history.',
  simulation: 'Prompt simulation datasets, scenarios and runs.',
  redteam: 'Red-team campaigns, reports, events and sandbox runs.',
  annotation: 'Human review annotation queues and items.',
  score: 'Log-level score records.',
  schema: 'Saved JSON schemas for structured output.',
  tag: 'Project tags and their attachments.',
  saved_view: 'Saved UI views (filters, display and time settings).',
  saved_dashboard: 'Saved dashboard configurations and widgets.',
  cache: 'Cached LLM responses.',
  export: 'Export sinks and export jobs.',
  webhook: 'Webhooks and webhook configurations.',
  notification_method: 'Alert channels (Slack, email, PagerDuty) used by monitor notifications.',
  limit_policy: 'Limit policies, their configuration and live counter state.',
};

const SELECT_PREFIX = 'select:';
const RESULT_LIMIT = 10;
const MIN_SCORE_RATIO = 0.5;
const TERM_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  add: ['create'],
  new: ['create'],
  make: ['create'],
  remove: ['delete'],
  drop: ['delete'],
  edit: ['update'],
  change: ['update'],
  modify: ['update'],
  show: ['get'],
  read: ['get'],
  fetch: ['get'],
  price: ['cost'],
  pricing: ['cost'],
  // Customer words for the backend's resource and action names.
  spend: ['cost'],
  trend: ['timeseries'],
  time: ['timeseries'],
  chart: ['timeseries'],
  breakdown: ['usage', 'grouped'],
  rank: ['usage'],
  top: ['usage'],
  total: ['summary'],
  count: ['summary', 'count'],
  stats: ['summary'],
  customer: ['end', 'user'],
  user: ['end'],
  alert: ['monitor'],
  alerts: ['monitor'],
  request: ['log'],
  requests: ['log'],
  span: ['log', 'span'],
  run: ['run', 'history'],
  publish: ['deploy'],
  release: ['deploy'],
  version: ['version', 'commit'],
  label: ['tag'],
  byok: ['integration'],
  credential: ['integration'],
  eval: ['evaluator', 'grader', 'experiment'],
  evaluation: ['evaluator', 'grader', 'experiment'],
};
/** Words that carry no tool meaning and match every description. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'for', 'in', 'on', 'at', 'to', 'by', 'per', 'over', 'from', 'with', 'and', 'or',
  'my', 'our', 'me', 'all', 'how', 'what', 'which', 'is', 'are', 'many', 'much', 'this', 'that', 'last', 'each',
]);
/** Full schemas for the best matches; the rest get a one-line summary. */
const FULL_SCHEMA_RESULTS = 3;
const SUMMARY_MAX_CHARS = 120;

/** Set to list every tool at connect, for clients that cannot use tool_run. */
export const LIST_ALL_TOOLS_ENV = 'RESPAN_MCP_LIST_ALL';
/** Per-request opt-in: `Respan-Tool-List: all`. */
export const LIST_ALL_TOOLS_HEADER_VALUE = 'all';

export function isListingAllTools(headerValue?: string): boolean {
  if (headerValue?.trim().toLowerCase() === LIST_ALL_TOOLS_HEADER_VALUE) return true;
  const env = process.env[LIST_ALL_TOOLS_ENV]?.trim().toLowerCase();
  return env === '1' || env === 'true';
}

export function foldedGroupOf(toolName: string): string | undefined {
  return Object.keys(FOLDED_TOOL_GROUPS).find((group) => toolName === group || toolName.startsWith(`${group}_`));
}

function expandTerm(term: string): Set<string> {
  const variants = new Set([term, ...(TERM_SYNONYMS[term] ?? [])]);
  if (term.endsWith('ies')) variants.add(`${term.slice(0, -3)}y`);
  else if (term.endsWith('s') && term.length > 3) variants.add(term.slice(0, -1));
  return variants;
}

function parseTerms(keywords: string): Set<string>[] {
  const terms = [...new Set(keywords.trim().toLowerCase().split(/[\s_,]+/))].filter((term) => term && !STOP_WORDS.has(term));
  return terms.map(expandTerm);
}

function propertyTokens(schema: unknown, tokens = new Set<string>()): Set<string> {
  if (!schema || typeof schema !== 'object') return tokens;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'properties' && value && typeof value === 'object') {
      for (const name of Object.keys(value)) name.split('_').forEach((token) => tokens.add(token));
    }
    if (value && typeof value === 'object') propertyTokens(value, tokens);
  }
  return tokens;
}

function score(tool: Tool, terms: Set<string>[]): number {
  const nameTokens = new Set(tool.name.split('_'));
  const resource = tool.name.split('_')[0];
  const description = (tool.description ?? '').toLowerCase();
  const props = propertyTokens(tool.inputSchema);
  let total = 0;
  for (const variants of terms) {
    const words = [...variants];
    if (words.some((word) => nameTokens.has(word))) total += 3;
    else if (words.some((word) => tool.name.includes(word))) total += 2;
    else if (words.some((word) => props.has(word) || description.includes(word))) total += 1;
  }
  // Naming the tool's own resource (its first word) breaks ties between
  // tools that match the same words: 'export log create' is an export.
  if (terms.some((variants) => variants.has(resource))) total += 1;
  return total;
}

/** Rank tools against keywords, or pick them by name with `select:a,b`. */
export function searchTools(tools: readonly Tool[], keywords: string, limit = RESULT_LIMIT): Tool[] {
  const query = keywords.trim().toLowerCase();
  if (query.startsWith(SELECT_PREFIX)) {
    const names = new Set(query.slice(SELECT_PREFIX.length).split(',').map((name) => resolveToolName(name.trim())));
    return tools.filter((tool) => names.has(tool.name));
  }
  const terms = parseTerms(query);
  const scored = tools.map((tool) => [score(tool, terms), tool] as const).filter(([value]) => value > 0);
  if (!scored.length) return [];
  const floor = Math.max(...scored.map(([value]) => value)) * MIN_SCORE_RATIO;
  return scored
    .filter(([value]) => value >= floor)
    .sort(([a, x], [b, y]) => b - a || x.name.split('_').length - y.name.split('_').length || x.name.localeCompare(y.name))
    .slice(0, limit)
    .map(([, tool]) => tool);
}

/** Folded groups a search names by resource word (cache, export, ...). */
export function matchFoldedGroups(keywords: string): string[] {
  const terms = parseTerms(keywords);
  return Object.keys(FOLDED_TOOL_GROUPS).filter((group) =>
    terms.some((variants) => group.split('_').some((word) => variants.has(word))),
  );
}

function summarize(description: string | undefined): string {
  return compactText(description ?? '', SUMMARY_MAX_CHARS);
}

export function foldedGroupLines(): string {
  return Object.entries(FOLDED_TOOL_GROUPS).map(([group, text]) => `- ${group}: ${text}`).join('\n');
}

type Handler = (request: unknown, extra: unknown) => Promise<any>;

function requestHandler(server: McpServer, method: string): Handler {
  // SDK-internal: McpServer installs its tools/list and tools/call handlers
  // here, and keeps no public reference to them.
  const handler = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers.get(method);
  if (!handler) throw new Error(`applyToolIndex: no ${method} handler; register the tools first`);
  return handler;
}

function jsonResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

/**
 * Adds tool_search and tool_run, and narrows tools/list to the eager tools
 * unless `listAll`. Call it after every tool is registered and after
 * removeWriteTools, so search and run see exactly what this session may call.
 */
export function applyToolIndex(server: McpServer, listAll: boolean): void {
  const listAllTools = requestHandler(server, 'tools/list');
  const callTool = requestHandler(server, 'tools/call');
  const hidden = hiddenWriteToolsOf(server);
  const registered = (server as unknown as { _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }> })._registeredTools;
  const canWrite = Object.values(registered).some((tool) => tool.annotations?.readOnlyHint !== true);

  const catalog = async (): Promise<Tool[]> => {
    const { tools } = await listAllTools({ method: 'tools/list', params: {} }, {});
    return (tools as Tool[]).filter((tool) => tool.name !== TOOL_SEARCH_NAME && tool.name !== TOOL_RUN_NAME);
  };

  server.registerTool(TOOL_SEARCH_NAME, {
    title: 'Find tools',
    description: 'Find Respan tools that are not listed and get their input schemas; run one with tool_run. '
      + 'The best matches come with their full input schema. Folded second-line groups (see the server instructions) '
      + 'are searched when the keywords name the group, or with include_folded=true.',
    inputSchema: {
      keywords: z.string().describe("Resource and action words, e.g. 'dataset log create' or 'experiment run'; or 'select:name_a,name_b' for exact tool names."),
      include_folded: z.boolean().optional().describe('Also search the folded second-line groups (full search).'),
    },
    annotations: READ_ONLY_WORKSPACE_TOOL,
  }, async (args) => {
    const all = await catalog();
    const isSelect = args.keywords.trim().toLowerCase().startsWith(SELECT_PREFIX);
    // A folded group the keywords name (cache, webhook, ...) is searched too.
    const named = new Set(matchFoldedGroups(args.keywords));
    const pool = args.include_folded || isSelect
      ? all
      : all.filter((tool) => { const group = foldedGroupOf(tool.name); return !group || named.has(group); });
    const found = searchTools(pool, args.keywords);
    return jsonResult({
      tools: found.map(({ name, description, inputSchema, annotations }, index) => {
        if (isSelect) return { name, ...(FULL_CONTRACTS.get(name) ?? { description, inputSchema }), annotations };
        return index < FULL_SCHEMA_RESULTS
          ? { name, description, inputSchema, readOnly: annotations?.readOnlyHint === true }
          : { name, summary: summarize(description) };
      }),
      ...(found.length ? {} : { hint: 'No match. Try other resource or action words, or include_folded=true.' }),
      ...(!isSelect && found.length > FULL_SCHEMA_RESULTS ? { more: "'select:<name>' returns a tool's full description and schema." } : {}),
    });
  });

  server.registerTool(TOOL_RUN_NAME, {
    title: 'Run a tool',
    description: 'Run a Respan tool by name with its arguments, after tool_search returned its input schema. '
      + 'Listed tools can be called directly.',
    inputSchema: {
      name: z.string().describe('Exact tool name from tool_search.'),
      arguments: z.record(z.any()).optional().describe("The tool's arguments, matching its inputSchema."),
    },
    annotations: canWrite
      ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
      : READ_ONLY_WORKSPACE_TOOL,
  }, async (args, extra) => {
    const name = resolveToolName(args.name);
    if (name === TOOL_SEARCH_NAME || name === TOOL_RUN_NAME) {
      return jsonResult({ error: { code: 'invalid_tool', message: `Call ${name} directly, not through tool_run.` } }, true);
    }
    if (hidden.has(name)) {
      return jsonResult({ error: { code: 'insufficient_scope', message: `${name} changes data, and this connection is read-only.` } }, true);
    }
    // A copy of extra: telemetry keys its per-call record by this object.
    return callTool({ method: 'tools/call', params: { name, arguments: args.arguments ?? {} } }, { ...extra });
  });

  if (listAll) return;
  const listed = new Set([...EAGER_TOOL_NAMES, TOOL_SEARCH_NAME, TOOL_RUN_NAME]);
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await listAllTools(request, extra);
    return { ...result, tools: (result.tools as Tool[]).filter((tool) => listed.has(tool.name)) };
  });
}

