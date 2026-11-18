// lib/shared/telemetry.ts
//
// One structured log line per tool call on the hosted servers, so we can see
// which tools agents use, which fail and how big the answers are. Lines go to
// stdout, which Vercel keeps as runtime logs; a log drain can ship them on.
//
// What is never logged: argument values, tool results, credentials. A call
// carries only the argument names, sizes, timings and status codes. A hashed
// credential (session_key) ties the calls of one stateless client together.
// It is hashed under its own prefix, so it cannot be matched against the
// token hashes the OAuth session store keeps.
//
// stdio is not instrumented: there stdout is the MCP protocol stream, and the
// process runs on the customer's machine, where nobody collects these lines.

import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveToolName } from './tool-aliases.js';
import { TOOL_CATEGORY_META_KEY } from './tool-catalog.js';

export const TOOL_CALL_EVENT = 'mcp.tool_call';
export const SESSION_INIT_EVENT = 'mcp.session_init';
export const TOOL_ALIAS_EVENT = 'mcp.tool_alias';
const EVENT_SCHEMA_VERSION = 1;

/** Bounds every client-supplied string we echo into a log line. */
const MAX_LOGGED_STRING_CHARS = 128;
/** Bounds the argument names and old tool names one line can carry. */
const MAX_LOGGED_NAMES = 32;
/** Bounds the tool_call lines one request (one server instance) can write. */
const MAX_TOOL_CALL_EVENTS_PER_SERVER = 50;
const SESSION_KEY_HEX_CHARS = 12;
const SESSION_KEY_DOMAIN = 'respan-mcp-telemetry-session-key\0';
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

export type AuthKind = 'oauth' | 'jwt' | 'api_key' | 'env' | 'none';
/**
 * `invalid_arguments`: the tool exists but the SDK rejected the call before
 * running it, almost always because the arguments failed the input schema.
 */
export type ToolCallStatus = 'ok' | 'tool_error' | 'exception' | 'unknown_tool' | 'invalid_arguments';

export interface TelemetryContext {
  /** Which hosted server: platform, enterprise or docs. */
  realm: string;
  authKind: AuthKind;
  /** First hex chars of sha256(credential); absent without a bearer. */
  sessionKey?: string;
  userAgent?: string;
  protocolVersion?: string;
  /** JSON-RPC id → the old tool name a tools/call used; see noteAliasedCalls. */
  aliasedCalls?: Map<unknown, string>;
}

interface ToolCallFields {
  /** The current (product) name, after any old name was rewritten. */
  tool: string;
  /** The tool's `respan/category`; absent for a tool this server lacks. */
  category?: string;
  alias_used: boolean;
  /** The old name the client sent, when `alias_used`. */
  alias?: string;
  status: ToolCallStatus;
  latency_ms?: number;
  result_chars?: number;
  arg_keys?: string[];
  http_status?: number;
  error_class?: string;
}

const COMMIT = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7) || undefined;

/** What the wrapped tool callback saw, keyed by the request's `extra` object. */
interface CallRecord {
  ran: boolean;
  threw: boolean;
  error?: unknown;
}
const callRecords = new WeakMap<object, CallRecord>();

function bounded(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, MAX_LOGGED_STRING_CHARS) : undefined;
}

function boundedNames(values: unknown[]): string[] {
  return values.slice(0, MAX_LOGGED_NAMES).map((value) => bounded(value) ?? '');
}

function emit(event: string, ctx: TelemetryContext, fields: object): void {
  console.info(JSON.stringify({
    event,
    v: EVENT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    commit: COMMIT,
    realm: ctx.realm,
    auth_kind: ctx.authKind,
    session_key: ctx.sessionKey,
    user_agent: ctx.userAgent,
    protocol_version: ctx.protocolVersion,
    ...fields,
  }));
}

/**
 * A short hash of a credential, so one client's calls can be grouped. The
 * domain prefix keeps it from being a prefix of hashOpaqueToken(credential),
 * which the session store keys OAuth sessions by.
 */
export function sessionKeyOf(credential: string | undefined): string | undefined {
  if (!credential) return undefined;
  return createHash('sha256')
    .update(SESSION_KEY_DOMAIN)
    .update(credential)
    .digest('hex')
    .slice(0, SESSION_KEY_HEX_CHARS);
}

/** How the caller authenticated, read from the bearer's shape only. */
export function authKindOf(bearer: string | undefined, hasEnvironmentKey: boolean): AuthKind {
  if (!bearer) return hasEnvironmentKey ? 'env' : 'none';
  if (bearer.startsWith('mcp_at_')) return 'oauth';
  return JWT_SHAPE.test(bearer) ? 'jwt' : 'api_key';
}

/** A signed-in user (OAuth or JWT) rather than an API key, which is bound to one project. */
export function isUserCredential(bearer: string | undefined): boolean {
  const kind = authKindOf(bearer, false);
  return kind === 'oauth' || kind === 'jwt';
}

/** `hasEnvironmentKey` is false for a server that never uses RESPAN_API_KEY. */
export function telemetryContext(
  realm: string,
  bearer: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  hasEnvironmentKey = Boolean(process.env.RESPAN_API_KEY),
): TelemetryContext {
  return {
    realm,
    authKind: authKindOf(bearer, hasEnvironmentKey),
    sessionKey: sessionKeyOf(bearer),
    userAgent: bounded(headers['user-agent']),
    protocolVersion: bounded(headers['mcp-protocol-version']),
  };
}

/**
 * Notes which tools/call messages in a request body use an old tool name,
 * keyed by JSON-RPC id. Call it just before rewriteToolCallNames, which
 * replaces those names, so each tool_call event can say an alias was used.
 */
export function noteAliasedCalls(ctx: TelemetryContext, body: unknown): void {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    const { method, id, params } = (message ?? {}) as { method?: unknown; id?: unknown; params?: { name?: unknown } };
    if (method !== 'tools/call' || typeof params?.name !== 'string') continue;
    if (resolveToolName(params.name) === params.name) continue;
    ctx.aliasedCalls ??= new Map();
    ctx.aliasedCalls.set(id, params.name);
  }
}

function lengthOf(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

/** Characters of text, base64 data and embedded resources, without re-serializing them. */
function resultChars(result: unknown): number | undefined {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return undefined;
  return content.reduce((total: number, item: { text?: unknown; data?: unknown; resource?: { text?: unknown; blob?: unknown } }) => (
    total + lengthOf(item?.text) + lengthOf(item?.data) + lengthOf(item?.resource?.text) + lengthOf(item?.resource?.blob)
  ), 0);
}

function isHttpStatus(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_HTTP_STATUS && (value as number) <= MAX_HTTP_STATUS;
}

/**
 * The backend HTTP status behind a thrown error, when there is one: rawFetch
 * sets `status`, the Respan SDK sets `statusCode`. Messages are not parsed.
 */
export function httpStatusOf(error: unknown): number | undefined {
  const candidate = error as { statusCode?: unknown; status?: unknown };
  for (const value of [candidate?.statusCode, candidate?.status]) {
    if (isHttpStatus(value)) return value;
  }
  return undefined;
}

function errorClassOf(error: unknown): string | undefined {
  return bounded((error as { name?: unknown })?.name) ?? bounded(error?.constructor?.name);
}

/** The argument names the client sent, before the input schema strips or defaults any. */
function argKeysOf(args: unknown): string[] | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return boundedNames(Object.keys(args).sort());
}

/**
 * The SDK calls a tool callback as cb(args, extra) or cb(extra); either way
 * `extra` comes last and is the object the tools/call handler received. The
 * wrapper only notes that the callback ran and what it threw; the event is
 * written once, by the handler wrapper below.
 */
function wrapCallback(callback: Function): Function {
  return async function instrumented(this: unknown, ...callArgs: unknown[]) {
    const extra = callArgs[callArgs.length - 1];
    const record = extra && typeof extra === 'object' ? callRecords.get(extra) : undefined;
    if (record) record.ran = true;
    try {
      return await callback.apply(this, callArgs);
    } catch (error) {
      if (record) {
        record.threw = true;
        record.error = error;
      }
      throw error;
    }
  };
}

function statusOf(name: string, names: Map<string, unknown>, record: CallRecord, result: unknown): ToolCallStatus {
  if (record.threw) return 'exception';
  const isError = Boolean((result as { isError?: unknown })?.isError);
  if (!record.ran && isError) return names.has(name) ? 'invalid_arguments' : 'unknown_tool';
  return isError ? 'tool_error' : 'ok';
}

/**
 * Logs one event per `tools/call` this server answers: calls that ran, calls
 * the SDK rejected for bad arguments, and calls to tools it does not have.
 * Call it before any tool is registered. It installs the SDK's tools/call
 * handler at once (so a server left with no tools still answers, and logs,
 * calls to unknown tools) wrapped in the logger, and wraps the callback of every tool
 * registered through `server.tool` or `server.registerTool` from here on (so
 * apply it after any patch that filters registrations).
 */
export function instrumentToolCalls(server: McpServer, ctx: TelemetryContext): void {
  if ((server as any)._toolHandlersInitialized) {
    throw new Error('instrumentToolCalls must run before any tool is registered');
  }
  /** Registered tool name → its `respan/category`, if the catalog set one. */
  const categories = new Map<string, string | undefined>();
  let emitted = 0;

  for (const method of ['tool', 'registerTool'] as const) {
    const original = (server as any)[method].bind(server);
    (server as any)[method] = function (name: string, ...rest: unknown[]) {
      const last = rest.length - 1;
      if (typeof rest[last] === 'function') {
        rest[last] = wrapCallback(rest[last] as Function);
      }
      const registered = original(name, ...rest);
      if (registered) {
        // Product vocabulary may have renamed it to its current name.
        const current = resolveToolName(name);
        const key = (server as any)._registeredTools?.[current] === registered ? current : name;
        const category = registered._meta?.[TOOL_CATEGORY_META_KEY];
        categories.set(key, typeof category === 'string' ? category : undefined);
      }
      return registered;
    };
  }

  const lowLevel = server.server;
  const originalSetRequestHandler = lowLevel.setRequestHandler.bind(lowLevel);
  (lowLevel as any).setRequestHandler = function (schema: unknown, handler: Function) {
    if (schema !== CallToolRequestSchema) return originalSetRequestHandler(schema as any, handler as any);
    return originalSetRequestHandler(CallToolRequestSchema, async (request: any, extra: any) => {
      const started = performance.now();
      const record: CallRecord = { ran: false, threw: false };
      callRecords.set(extra, record);
      const name = String(request?.params?.name ?? '');
      const alias = ctx.aliasedCalls?.get(extra?.requestId);
      const log = (fields: Partial<ToolCallFields>) => {
        if (emitted >= MAX_TOOL_CALL_EVENTS_PER_SERVER) return;
        emitted += 1;
        emit(TOOL_CALL_EVENT, ctx, {
          tool: bounded(name) ?? '',
          category: categories.get(name),
          alias_used: alias !== undefined,
          alias: bounded(alias),
          latency_ms: Math.round(performance.now() - started),
          arg_keys: argKeysOf(request?.params?.arguments),
          ...fields,
        });
      };
      try {
        const result = await handler(request, extra);
        const status = statusOf(name, categories, record, result);
        log(status === 'exception'
          ? { status, http_status: httpStatusOf(record.error), error_class: errorClassOf(record.error) }
          : { status, result_chars: status === 'ok' || status === 'tool_error' ? resultChars(result) : undefined });
        return result;
      } catch (error) {
        log({ status: 'exception', http_status: httpStatusOf(error), error_class: errorClassOf(error) });
        throw error;
      } finally {
        callRecords.delete(extra);
      }
    });
  };
  // SDK-internal; without it the handler still installs, wrapped, on the first registration.
  const installToolHandlers = (server as any).setToolRequestHandlers;
  if (typeof installToolHandlers === 'function') installToolHandlers.call(server);
}

/**
 * Logs what the request said outside of tool calls: the old tool names its
 * tools/call messages used before they were rewritten (also when the
 * transport rejected the request, so no tool_call event was written), and
 * `initialize`, which names the client. Call it after the transport has
 * answered. A session is logged only when the server completed the handshake
 * (it then knows the client) and the request was not refused afterwards
 * (`isAccepted`).
 */
export function recordRequest(
  server: McpServer,
  ctx: TelemetryContext,
  body: unknown,
  aliasedNames: string[],
  isAccepted: boolean,
): void {
  const clientInfo = isAccepted ? server.server.getClientVersion() : undefined;
  if (clientInfo) {
    const messages = Array.isArray(body) ? body : [body];
    const init = messages.find((message) => (message as { method?: unknown })?.method === 'initialize') as
      | { params?: { protocolVersion?: unknown } }
      | undefined;
    emit(SESSION_INIT_EVENT, ctx, {
      client_name: bounded(clientInfo.name),
      client_version: bounded(clientInfo.version),
      requested_protocol_version: bounded(init?.params?.protocolVersion),
    });
  }
  if (aliasedNames.length > 0) {
    emit(TOOL_ALIAS_EVENT, ctx, { old_names: boundedNames(aliasedNames) });
  }
}
