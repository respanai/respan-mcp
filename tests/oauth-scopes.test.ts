import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthBroker } from '../lib/oauth/broker.js';
import { loadOAuthConfig, resetOAuthConfigForTests } from '../lib/oauth/config.js';
import { encryptCredential, generateOpaqueToken, hashOpaqueToken } from '../lib/oauth/crypto.js';
import { InMemorySessionStore } from '../lib/oauth/memory-store.js';
import { RECORD_VERSION } from '../lib/oauth/records.js';
import {
  grantedScope,
  hasWriteScope,
  isReadOnlySession,
  LEGACY_SCOPE_ENV,
  requestedScope,
} from '../lib/oauth/scopes.js';
import { resetSessionStoreForTests, setSessionStoreForTests } from '../lib/oauth/store-factory.js';
import { createMcpHandler, createServer } from '../lib/shared/mcp-handler.js';
import { TOOL_ALIASES } from '../lib/shared/tool-aliases.js';
import { hiddenWriteToolsOf, removeWriteTools } from '../lib/shared/tool-policy.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import authorizationServerMetadata from '../api/well-known/oauth-authorization-server.js';
import protectedResourceMetadata from '../api/well-known/oauth-protected-resource.js';

import { TOOL_RUN_NAME } from '../lib/shared/tool-index.js';

// These tests cover the whole tool surface, not only the tools listed by default.
process.env.RESPAN_MCP_LIST_ALL = '1';

const SECRET = 'scope-test-secret-that-is-at-least-thirty-two-chars';
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://127.0.0.1/callback';

class MockResponse {
  statusCode = 200;
  headers = new Map<string, string | string[]>();
  body: any;
  headersSent = false;
  setHeader(name: string, value: string | string[]) { this.headers.set(name.toLowerCase(), value); return this; }
  getHeader(name: string) { return this.headers.get(name.toLowerCase()); }
  status(code: number) { this.statusCode = code; return this; }
  json(body: unknown) { this.body = body; this.headersSent = true; return this; }
  send(body: unknown) { this.body = body; this.headersSent = true; return this; }
  end() { this.headersSent = true; return this; }
}

function jwt(marker: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60, marker }))
    .toString('base64url');
  return `${header}.${payload}.signature`;
}

function rpc(credential: string, method: string, params: unknown) {
  return {
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${credential}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: { jsonrpc: '2.0', id: 7, method, params },
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

function rpcResult(response: MockResponse): any {
  if (typeof response.body === 'object' && response.body !== null && !Buffer.isBuffer(response.body)) {
    return response.body;
  }
  const text = String(response.body);
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data ? data.slice('data: '.length) : text);
}

async function issue(
  store: InMemorySessionStore,
  { scope, isWriteApproved, fetch }: { scope?: string; isWriteApproved: boolean; fetch?: typeof globalThis.fetch },
) {
  const config = loadOAuthConfig(process.env);
  const broker = new OAuthBroker({ config, store, fetch });
  const started = await broker.startAuthorization({
    realm: 'platform',
    clientId: 'enc_client',
    clientName: 'Scope test',
    redirectUri: REDIRECT,
    clientState: 'state',
    codeChallenge: CHALLENGE,
    resource: config.realms.platform.resource,
    scope,
  });
  await broker.approveAuthorization('platform', started.transactionToken, started.browserCsrf, undefined, isWriteApproved);
  const redirect = await broker.completeAuthorization({
    realm: 'platform',
    transactionToken: started.transactionToken,
    browserCsrf: started.browserCsrf,
    backendAccessJwt: jwt('access'),
    backendRefreshJwt: jwt('refresh'),
  });
  const pair = await broker.exchangeAuthorizationCode({
    code: new URL(redirect).searchParams.get('code')!,
    codeVerifier: VERIFIER,
    clientId: 'enc_client',
    redirectUri: REDIRECT,
  });
  return { broker, pair, transaction: started.transaction };
}

/** A session minted before scopes existed: its code record has no scope. */
async function issueLegacy(store: InMemorySessionStore) {
  const config = loadOAuthConfig(process.env);
  const broker = new OAuthBroker({ config, store });
  const codeToken = generateOpaqueToken('mcp_ac_');
  const now = Date.now();
  await store.createAuthorizationCode('platform', hashOpaqueToken(codeToken), {
    version: RECORD_VERSION,
    clientId: 'enc_client',
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    realm: 'platform',
    resource: config.realms.platform.resource,
    encryptedBackendAccessJwt: encryptCredential(jwt('access'), SECRET),
    backendAccessExpiresAt: now + 3_600_000,
    encryptedBackendRefreshJwt: encryptCredential(jwt('refresh'), SECRET),
    backendRefreshExpiresAt: now + 86_400_000,
    createdAt: now,
    expiresAt: now + 600_000,
  }, 600);
  return broker.exchangeAuthorizationCode({
    code: codeToken, codeVerifier: VERIFIER, clientId: 'enc_client', redirectUri: REDIRECT,
  });
}

describe('scope rules', () => {
  it('treats a missing scope as asking for everything, always including read', () => {
    expect(requestedScope(undefined)).toBe('mcp:read mcp:write');
    expect(requestedScope('')).toBe('mcp:read mcp:write');
    expect(requestedScope('mcp:write')).toBe('mcp:read mcp:write');
    expect(requestedScope('mcp:read openid profile')).toBe('mcp:read');
  });

  it('treats a scope with no supported value as a missing one', () => {
    expect(requestedScope('claudeai')).toBe('mcp:read mcp:write');
    expect(requestedScope('openid offline_access')).toBe('mcp:read mcp:write');
  });

  it('grants write only when asked for and approved', () => {
    expect(grantedScope('mcp:read mcp:write', false)).toBe('mcp:read');
    expect(grantedScope('mcp:read mcp:write', true)).toBe('mcp:read mcp:write');
    expect(grantedScope('mcp:read', true)).toBe('mcp:read');
    expect(hasWriteScope('mcp:read')).toBe(false);
  });

  it('keeps legacy sessions at full access unless the kill switch is set', () => {
    expect(isReadOnlySession('mcp:read', {})).toBe(true);
    expect(isReadOnlySession('mcp:read mcp:write', {})).toBe(false);
    expect(isReadOnlySession(undefined, {})).toBe(false);
    expect(isReadOnlySession(undefined, { [LEGACY_SCOPE_ENV]: 'read' })).toBe(true);
    expect(isReadOnlySession(undefined, { [LEGACY_SCOPE_ENV]: 'mcp:read' })).toBe(true);
    expect(isReadOnlySession(undefined, { [LEGACY_SCOPE_ENV]: '  ' })).toBe(false);
  });
});

describe('scopes through the OAuth broker', () => {
  beforeEach(() => {
    process.env.OAUTH_SECRET = SECRET;
    process.env.OAUTH_SESSION_STORE = 'memory';
    process.env.MCP_PUBLIC_BASE_URL = 'https://mcp.respan.ai';
    resetOAuthConfigForTests();
  });

  it('records what the client asked for and grants read-only without approval', async () => {
    const store = new InMemorySessionStore();
    const { pair, transaction } = await issue(store, { isWriteApproved: false });
    expect(transaction.requestedScope).toBe('mcp:read mcp:write');
    expect(pair.scope).toBe('mcp:read');
  });

  it('grants write when approved and keeps the scope through a refresh', async () => {
    const store = new InMemorySessionStore();
    const backendRefresh = vi.fn(async () => new Response(
      JSON.stringify({ access: jwt('access-2'), refresh: jwt('refresh-2') }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const { broker, pair } = await issue(store, { isWriteApproved: true, fetch: backendRefresh });
    expect(pair.scope).toBe('mcp:read mcp:write');

    const refreshed = await broker.refresh({ refreshToken: pair.refresh_token, clientId: 'enc_client' });
    expect(backendRefresh).toHaveBeenCalledTimes(1);
    expect(refreshed.scope).toBe('mcp:read mcp:write');
  });

  it('never grants write to a client that only asked for read', async () => {
    const store = new InMemorySessionStore();
    const { pair } = await issue(store, { scope: 'mcp:read', isWriteApproved: true });
    expect(pair.scope).toBe('mcp:read');
  });

  it('keeps a pre-scope session without a scope', async () => {
    const pair = await issueLegacy(new InMemorySessionStore());
    expect(pair.scope).toBeUndefined();
  });
});

describe('scopes on the hosted /mcp endpoint', () => {
  const handler = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');

  beforeEach(async () => {
    process.env.OAUTH_SECRET = SECRET;
    process.env.OAUTH_SESSION_STORE = 'memory';
    process.env.MCP_PUBLIC_BASE_URL = 'https://mcp.respan.ai';
    delete process.env[LEGACY_SCOPE_ENV];
    resetOAuthConfigForTests();
    await resetSessionStoreForTests();
  });

  afterEach(() => {
    delete process.env[LEGACY_SCOPE_ENV];
    vi.restoreAllMocks();
  });

  async function toolNames(accessToken: string): Promise<string[]> {
    const response = new MockResponse();
    await handler(rpc(accessToken, 'tools/list', {}), response as any);
    return rpcResult(response).result.tools.map((tool: { name: string }) => tool.name);
  }

  it('shows a read-only session only read-only tools', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const { pair } = await issue(store, { isWriteApproved: false });
    const names = await toolNames(pair.access_token);
    expect(names).toContain('log_list');
    expect(names).toContain('prompt_get');
    for (const write of ['prompt_deploy', 'prompt_create', 'monitor_delete', 'behavior_settings_update', 'workspace_switch']) {
      expect(names, write).not.toContain(write);
    }
  });

  it('answers a hidden write tool with insufficient_scope instead of running it', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const { pair } = await issue(store, { isWriteApproved: false });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = new MockResponse();
    await handler(rpc(pair.access_token, 'tools/call', { name: 'prompt_deploy', arguments: { prompt_id: 'p1' } }), response as any);

    const { id, result } = rpcResult(response);
    expect(id).toBe(7);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toMatchObject({
      code: 'insufficient_scope',
      required_scope: 'mcp:write',
    });
    expect(result._meta['mcp/www_authenticate'][0]).toContain('error="insufficient_scope"');
    expect(result._meta['mcp/www_authenticate'][0]).toContain('scope="mcp:read mcp:write"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a write tool called by its old name with insufficient_scope', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const { pair } = await issue(store, { isWriteApproved: false });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = new MockResponse();
    await handler(rpc(pair.access_token, 'tools/call', { name: 'deploy_prompt_version', arguments: {} }), response as any);

    expect(JSON.parse(rpcResult(response).result.content[0].text).error.code).toBe('insufficient_scope');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers a batch of hidden write tool calls with insufficient_scope for each', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const { pair } = await issue(store, { isWriteApproved: false });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const request = rpc(pair.access_token, 'tools/call', {});
    request.body = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prompt_deploy', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'monitor_delete', arguments: {} } },
    ];
    const response = new MockResponse();
    await handler(request, response as any);

    const results = response.body as any[];
    expect(results.map((r) => r.id)).toEqual([1, 2]);
    for (const r of results) {
      expect(JSON.parse(r.result.content[0].text).error.code).toBe('insufficient_scope');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not answer an id-less tools/call with a scope result', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const { pair } = await issue(store, { isWriteApproved: false });
    const request = rpc(pair.access_token, 'tools/call', { name: 'prompt_deploy', arguments: {} });
    delete request.body.id;
    const response = new MockResponse();
    await handler(request, response as any);

    expect(String(JSON.stringify(response.body ?? '')).includes('insufficient_scope')).toBe(false);
  });

  it('shows write tools to a session that was allowed changes', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const { pair } = await issue(store, { isWriteApproved: true });
    const names = await toolNames(pair.access_token);
    expect(names).toContain('prompt_deploy');
    expect(names).toContain('log_list');
  });

  it('leaves pre-scope sessions at full access, and the kill switch makes them read-only', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const pair = await issueLegacy(store);
    expect(await toolNames(pair.access_token)).toContain('prompt_deploy');

    process.env[LEGACY_SCOPE_ENV] = 'read';
    expect(await toolNames(pair.access_token)).not.toContain('prompt_deploy');
  });

  it('does not filter API keys, whose permissions the backend enforces', async () => {
    setSessionStoreForTests(new InMemorySessionStore());
    expect(await toolNames('AbCdEfGh.0123456789abcdef0123456789abcdef')).toContain('prompt_deploy');
  });
});

describe('the read-only gate covers the whole tool surface', () => {
  const handler = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');
  const API_KEY = 'AbCdEfGh.0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    process.env.OAUTH_SECRET = SECRET;
    process.env.OAUTH_SESSION_STORE = 'memory';
    process.env.MCP_PUBLIC_BASE_URL = 'https://mcp.respan.ai';
    delete process.env[LEGACY_SCOPE_ENV];
    resetOAuthConfigForTests();
    await resetSessionStoreForTests();
  });

  afterEach(() => vi.restoreAllMocks());

  async function listTools(credential: string): Promise<{ name: string; annotations?: { readOnlyHint?: boolean } }[]> {
    const response = new MockResponse();
    await handler(rpc(credential, 'tools/list', {}), response as any);
    return rpcResult(response).result.tools;
  }

  async function readOnlyToken(): Promise<string> {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    return (await issue(store, { isWriteApproved: false })).pair.access_token;
  }

  /**
   * Every tool createServer registers. tools/list over HTTP must return all of
   * them, so the gate is checked against the whole surface, however many tools
   * other changes add or remove.
   */
  function registeredToolNames(): string[] {
    const server = createServer(null) as unknown as { _registeredTools: Record<string, unknown> };
    return Object.keys(server._registeredTools).filter((name) => name !== TOOL_RUN_NAME);
  }

  /** The loops below call the handler once per write tool; CI runners are a few times slower than a laptop. */
  const SURFACE_LOOP_TIMEOUT_MS = 30_000;

  /**
   * Every tool on the full surface, split by its own readOnlyHint (false or
   * missing = write). tool_run takes its hint from the session, so it is
   * checked on its own.
   */
  async function surface() {
    const all = (await listTools(API_KEY)).filter((tool) => tool.name !== TOOL_RUN_NAME);
    return {
      all,
      writes: all.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name),
      reads: all.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name),
    };
  }

  it('lists none of the write tools, and every read tool, to a read-only session', async () => {
    const { all, writes, reads } = await surface();
    expect(all.map((tool) => tool.name).sort()).toEqual(registeredToolNames().sort());
    for (const name of [
      'monitor_create', 'monitor_update', 'monitor_delete', 'monitor_commit', 'monitor_deploy',
      'monitor_undeploy', 'behavior_disabled_set', 'project_switch', 'prompt_create',
      'prompt_update', 'prompt_draft_create', 'prompt_commit', 'prompt_deploy',
      'custom_behavior_create', 'custom_behavior_update', 'custom_behavior_delete',
    ]) expect(writes, name).toContain(name);

    const listed = (await listTools(await readOnlyToken())).map((tool) => tool.name).filter((name) => name !== TOOL_RUN_NAME);
    expect(listed.filter((name) => writes.includes(name))).toEqual([]);
    expect([...listed].sort()).toEqual([...reads].sort());
  });

  it('refuses every write tool with insufficient_scope without calling the backend', async () => {
    const { writes } = await surface();
    const token = await readOnlyToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const name of writes) {
      const response = new MockResponse();
      await handler(rpc(token, 'tools/call', { name, arguments: {} }), response as any);
      const error = JSON.parse(rpcResult(response).result.content[0].text).error;
      expect(error.code, name).toBe('insufficient_scope');
      expect(error.message, name).toContain(name);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  }, SURFACE_LOOP_TIMEOUT_MS);

  it('refuses every old name of a write tool with insufficient_scope', async () => {
    const { writes } = await surface();
    const aliases = Object.keys(TOOL_ALIASES).filter((old) => writes.includes(TOOL_ALIASES[old]));
    expect(aliases).toEqual(expect.arrayContaining(['org_switch', 'switch_organization', 'deploy_prompt_version']));
    const token = await readOnlyToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const name of aliases) {
      const response = new MockResponse();
      await handler(rpc(token, 'tools/call', { name, arguments: {} }), response as any);
      expect(JSON.parse(rpcResult(response).result.content[0].text).error.code, name).toBe('insufficient_scope');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses every write tool through tool_run, by current and old name', async () => {
    const { writes } = await surface();
    const aliases = Object.keys(TOOL_ALIASES).filter((old) => writes.includes(TOOL_ALIASES[old]));
    const token = await readOnlyToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const name of [...writes, ...aliases]) {
      const response = new MockResponse();
      await handler(rpc(token, 'tools/call', { name: TOOL_RUN_NAME, arguments: { name, arguments: {} } }), response as any);
      expect(JSON.parse(rpcResult(response).result.content[0].text).error.code, name).toBe('insufficient_scope');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  }, SURFACE_LOOP_TIMEOUT_MS);

  it('records the product names it hid, not the registration names', () => {
    const hidden = hiddenWriteToolsOf(createServer(null, undefined, undefined, true));
    expect(hidden.has('project_switch')).toBe(true);
    expect(hidden.has('org_switch')).toBe(false);
  });

  it('treats a tool with no annotations, or readOnlyHint false, as a write', () => {
    const server = new McpServer({ name: 'gate-test', version: '1' });
    server.registerTool('no_hints', { description: 'x' }, async () => ({ content: [] }));
    server.registerTool('says_write', { description: 'x', annotations: { readOnlyHint: false } }, async () => ({ content: [] }));
    server.registerTool('says_read', { description: 'x', annotations: { readOnlyHint: true } }, async () => ({ content: [] }));
    removeWriteTools(server);
    expect([...hiddenWriteToolsOf(server)].sort()).toEqual(['no_hints', 'says_write']);
    expect(Object.keys((server as any)._registeredTools)).toEqual(['says_read']);
  });
});

describe('scope discovery', () => {
  it('advertises the supported scopes', () => {
    for (const metadata of [authorizationServerMetadata, protectedResourceMetadata]) {
      const response = new MockResponse();
      metadata({ method: 'GET' } as any, response as any);
      expect(response.body.scopes_supported).toEqual(['mcp:read', 'mcp:write']);
    }
  });
});
