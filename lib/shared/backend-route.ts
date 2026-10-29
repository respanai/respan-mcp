// lib/shared/backend-route.ts
//
// A backend-catalog tool as data: the HTTP request its backend executor sends
// (admin/mcp_server/*_tools.py in respan-backend). One generic executor turns
// the arguments into that request and returns the response, so every routed
// tool is a thin wrapper: the server validates, defaults and shapes.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { AuthenticatedClient } from './client.js';
import { rawFetch } from './client.js';
import { BACKEND_TOOLS, registerBackendTool, type BackendToolContract } from './backend-tool.js';
import { ADDITIVE_WRITE_TOOL, DESTRUCTIVE_TOOL } from './tool-policy.js';
import { TOOL_ALIASES, resolveToolName } from './tool-aliases.js';
import { READ_ONLY_WORKSPACE_TOOL } from './tool-result.js';

export interface BackendRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `{arg}` placeholders are filled from the arguments. */
  path: string;
  /** Argument keys sent as query params; `const:key=value` sends a fixed one. */
  query?: readonly string[];
  /** Argument keys sent in the JSON body; `const:key=value` sends a fixed (JSON) value. */
  body?: readonly string[];
  /** Pick this request only when the argument is present; the first match wins. */
  when?: string;
}

export interface BackendRoute {
  requests: readonly BackendRequest[];
  /** Deletes, overwrites, deploys, undeploys or revokes. */
  destructive?: boolean;
  /** Arguments the backend reads under another key: `{arg: wire_key}`. */
  renames?: Readonly<Record<string, string>>;
  /** Arguments the backend reads as a one-element list. */
  lists?: readonly string[];
  /** Arguments the backend reads as a JSON string. */
  json?: readonly string[];
  /** An argument whose object is the whole body. */
  spread?: string;
  /** Path arguments that may contain `/`: each segment is encoded, the slashes kept. */
  slashed?: readonly string[];
  /** `filters` fields the endpoint cannot compile: it 500s or matches nothing, so they are refused. */
  unsupportedFilters?: readonly string[];
}

const PLACEHOLDER = /\{([a-z0-9_]+)\}/g;

/** Backend tools still named for organizations; the product calls them projects. */
export const PUBLIC_TOOL_NAMES: Readonly<Record<string, string>> = {
  org_get: 'project_get',
  org_member_list: 'project_member_list',
};
const CONST_PREFIX = 'const:';

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function constEntry(entry: string): [string, string] {
  const [key, ...rest] = entry.slice(CONST_PREFIX.length).split('=');
  return [key, rest.join('=')];
}

function jsonValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** The argument keys a route sends anywhere; the rest never reach the server. */
export function forwardedArgs(route: BackendRoute): Set<string> {
  const keys = new Set<string>();
  for (const request of route.requests) {
    for (const [, key] of request.path.matchAll(PLACEHOLDER)) keys.add(key);
    for (const entry of [...request.query ?? [], ...request.body ?? []]) {
      if (!entry.startsWith(CONST_PREFIX)) keys.add(entry);
    }
    if (request.when) keys.add(request.when);
  }
  if (route.spread) keys.add(route.spread);
  return keys;
}

/** The request `args` select, as the backend executor would send it. */
export function buildRequest(route: BackendRoute, args: Record<string, unknown>) {
  const filters = args.filters;
  const refused = route.unsupportedFilters && filters && typeof filters === 'object'
    ? Object.keys(filters).filter((field) => route.unsupportedFilters!.includes(field)).sort()
    : [];
  if (refused.length) {
    throw new Error(`Cannot filter by ${refused.join(', ')} here. Use log_list for behaviors, topics, fault_domain or messages_smart; the project comes from your credential.`);
  }
  const request = route.requests.find((candidate) => !candidate.when || isPresent(args[candidate.when]));
  if (!request) throw new Error(`Provide one of: ${route.requests.map((candidate) => candidate.when).join(', ')}.`);
  const wire = (key: string) => route.renames?.[key] ?? key;
  const value = (key: string) => {
    if (!isPresent(args[key])) return args[key];
    if (route.lists?.includes(key)) return [args[key]];
    if (route.json?.includes(key)) return JSON.stringify(args[key]);
    return args[key];
  };
  const path = request.path.replace(PLACEHOLDER, (_, key: string) => {
    if (!isPresent(args[key])) throw new Error(`${key} is required.`);
    const text = String(args[key]);
    return route.slashed?.includes(key)
      ? text.split('/').map(encodeURIComponent).join('/')
      : encodeURIComponent(text);
  });
  const query: Record<string, string | number | boolean | undefined> = {};
  for (const entry of request.query ?? []) {
    if (entry.startsWith(CONST_PREFIX)) {
      const [key, value] = constEntry(entry);
      query[key] = value;
      continue;
    }
    const value = args[entry];
    if (!isPresent(value)) continue;
    // Lists go comma-joined, as the backend's _build_query_string sends them.
    query[wire(entry)] = Array.isArray(value)
      ? value.join(',')
      : typeof value === 'object' ? JSON.stringify(value) : value as string | number | boolean;
  }
  let body: Record<string, unknown> | undefined;
  if (route.spread && isPresent(args[route.spread])) {
    body = { ...(args[route.spread] as Record<string, unknown>) };
  } else if (request.body?.length) {
    body = {};
    for (const entry of request.body) {
      if (entry.startsWith(CONST_PREFIX)) {
        const [key, value] = constEntry(entry);
        body[key] = jsonValue(value);
      } else if (args[entry] !== undefined) {
        body[wire(entry)] = value(entry);
      }
    }
  }
  return { method: request.method, path, query, body };
}

const TOOL_NAME_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * Catalog text names the agent's tools: a name this server shows differently
 * is rewritten, and a sentence naming a tool it does not serve is dropped.
 */
export function alignText(text: string, published: ReadonlySet<string>): string {
  const known = (token: string) => BACKEND_TOOLS.has(token) || token in TOOL_ALIASES;
  const renamed = text.replace(TOOL_NAME_TOKEN, (token) => {
    const current = PUBLIC_TOOL_NAMES[token] ?? resolveToolName(token);
    return current !== token && published.has(current) ? current : token;
  });
  const isDangling = (sentence: string) =>
    [...sentence.matchAll(TOOL_NAME_TOKEN)].some(([token]) => known(token) && !published.has(token));
  return renamed
    .split('\n')
    .map((line) => line.split(/(?<=[.!?])\s+/).filter((sentence) => !isDangling(sentence)).join(' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function alignSchema(node: unknown, published: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((item) => alignSchema(item, published));
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [
    key,
    key === 'description' && typeof value === 'string' ? alignText(value, published) : alignSchema(value, published),
  ]));
}

/** The catalog contract narrowed to the arguments this route sends. */
function routedContract(name: string, route: BackendRoute, published: ReadonlySet<string>): BackendToolContract {
  const contract = BACKEND_TOOLS.get(name);
  if (!contract) throw new Error(`registerRoutedTools: '${name}' is not in lib/generated/backend-tools.json`);
  const sent = forwardedArgs(route);
  const { properties = {}, required = [], ...schema } = contract.inputSchema;
  return {
    ...contract,
    description: alignText(contract.description, published),
    inputSchema: alignSchema({
      ...schema,
      properties: Object.fromEntries(Object.entries(properties).filter(([key]) => sent.has(key))),
      required: required.filter((key) => sent.has(key)),
    }, published) as BackendToolContract['inputSchema'],
  };
}

function annotationsOf(name: string, route: BackendRoute): ToolAnnotations {
  if (BACKEND_TOOLS.get(name)?.readOnly) return READ_ONLY_WORKSPACE_TOOL;
  return route.destructive ? DESTRUCTIVE_TOOL : ADDITIVE_WRITE_TOOL;
}

/** Registers every routed tool under its backend name, description and schema. */
export function registerRoutedTools(
  server: McpServer,
  client: AuthenticatedClient | null,
  routes: Readonly<Record<string, BackendRoute>>,
  published: ReadonlySet<string>,
): void {
  for (const [name, route] of Object.entries(routes)) {
    const shown = PUBLIC_TOOL_NAMES[name] ?? name;
    registerBackendTool(server, client, shown, annotationsOf(name, route), (c, args) => {
      const { method, path, query, body } = buildRequest(route, args);
      return rawFetch(c, path, { method, query, body });
    }, { ...routedContract(name, route, published), name: shown });
  }
}
