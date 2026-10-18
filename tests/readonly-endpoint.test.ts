import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthBroker } from '../lib/oauth/broker.js';
import { loadOAuthConfig, resetOAuthConfigForTests } from '../lib/oauth/config.js';
import { InMemorySessionStore } from '../lib/oauth/memory-store.js';
import { resetSessionStoreForTests, setSessionStoreForTests } from '../lib/oauth/store-factory.js';
import readOnlyHandler from '../api/mcp/readonly.js';
import enterpriseReadOnlyHandler from '../api/mcp/enterprise-readonly.js';
import { createMcpHandler } from '../lib/shared/mcp-handler.js';
import readOnlyResourceMetadata from '../api/well-known/oauth-protected-resource-readonly.js';
import enterpriseReadOnlyResourceMetadata from '../api/well-known/oauth-protected-resource-enterprise-readonly.js';

// These tests cover the whole tool surface, not only the tools listed by default.
process.env.RESPAN_MCP_LIST_ALL = '1';

const SECRET = 'readonly-test-secret-that-is-at-least-thirty-two';
const VERIFIER = 'r'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://127.0.0.1/callback';
const API_KEY = 'AbCdEfGh.0123456789abcdef0123456789abcdef';

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

function rpc(credential: string, method: string, params: unknown, url = '/mcp/readonly') {
  return {
    method: 'POST',
    url,
    headers: {
      authorization: `Bearer ${credential}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: { jsonrpc: '2.0', id: 3, method, params },
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

async function toolNames(handler: (req: any, res: any) => Promise<unknown>, credential: string, url?: string) {
  const response = new MockResponse();
  await handler(rpc(credential, 'tools/list', {}, url), response as any);
  return rpcResult(response).result.tools.map((tool: { name: string }) => tool.name);
}

beforeEach(async () => {
  process.env.OAUTH_SECRET = SECRET;
  process.env.OAUTH_SESSION_STORE = 'memory';
  process.env.MCP_PUBLIC_BASE_URL = 'https://mcp.respan.ai';
  delete process.env.MCP_LEGACY_SCOPE;
  resetOAuthConfigForTests();
  await resetSessionStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/mcp/readonly with an API key', () => {
  it('lists only read-only tools', async () => {
    setSessionStoreForTests(new InMemorySessionStore());
    const names = await toolNames(readOnlyHandler, API_KEY);
    expect(names).toContain('log_list');
    expect(names).toContain('trace_get');
    for (const write of ['prompt_deploy', 'prompt_create', 'monitor_delete', 'custom_behavior_delete', 'workspace_switch']) {
      expect(names, write).not.toContain(write);
    }
  });

  it('refuses a write tool and points at the full URL, without a consent challenge', async () => {
    setSessionStoreForTests(new InMemorySessionStore());
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const response = new MockResponse();
    await readOnlyHandler(rpc(API_KEY, 'tools/call', { name: 'monitor_delete', arguments: {} }), response as any);

    const { result } = rpcResult(response);
    expect(result.isError).toBe(true);
    const error = JSON.parse(result.content[0].text).error;
    expect(error.code).toBe('insufficient_scope');
    expect(error.hint).toContain('/mcp/readonly');
    expect(error.required_scope).toBeUndefined();
    expect(result._meta).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('explains a batch of write calls with the read-only-URL variant', async () => {
    setSessionStoreForTests(new InMemorySessionStore());
    const request = rpc(API_KEY, 'tools/call', {});
    request.body = [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'monitor_delete', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'prompt_deploy', arguments: {} } },
    ];
    const response = new MockResponse();
    await readOnlyHandler(request, response as any);
    expect(response.body).toHaveLength(2);
    for (const { result } of response.body) {
      const error = JSON.parse(result.content[0].text).error;
      expect(error.code).toBe('insufficient_scope');
      expect(error.hint).toContain('/mcp/readonly');
      expect(error.required_scope).toBeUndefined();
      expect(result._meta).toBeUndefined();
    }
  });

  it('filters the enterprise read-only URL too', async () => {
    setSessionStoreForTests(new InMemorySessionStore());
    const names = await toolNames(enterpriseReadOnlyHandler, API_KEY, '/mcp/enterprise/readonly');
    expect(names).toContain('log_list');
    expect(names).not.toContain('prompt_deploy');
  });

  it('leaves /mcp unfiltered for the same key', async () => {
    setSessionStoreForTests(new InMemorySessionStore());
    const full = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');
    expect(await toolNames(full, API_KEY, '/mcp')).toContain('prompt_deploy');
  });
});

describe('/mcp/readonly with OAuth', () => {
  it('grants read scope only, binds the token to /mcp, and works on both URLs', async () => {
    const store = new InMemorySessionStore();
    setSessionStoreForTests(store);
    const config = loadOAuthConfig(process.env);
    const broker = new OAuthBroker({ config, store });
    const readOnlyResource = 'https://mcp.respan.ai/mcp/readonly';

    const started = await broker.startAuthorization({
      realm: 'platform',
      clientId: 'enc_client',
      clientName: 'Read-only URL test',
      redirectUri: REDIRECT,
      clientState: 'state',
      codeChallenge: CHALLENGE,
      resource: readOnlyResource,
    });
    expect(started.transaction.resource).toBe('https://mcp.respan.ai/mcp');
    expect(started.transaction.requestedScope).toBe('mcp:read');

    // Even a tampered "allow changes" cannot widen what the client asked for.
    await broker.approveAuthorization('platform', started.transactionToken, started.browserCsrf, undefined, true);
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
      resource: readOnlyResource,
    });
    expect(pair.scope).toBe('mcp:read');

    const full = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');
    expect(await toolNames(readOnlyHandler, pair.access_token)).not.toContain('prompt_deploy');
    const onFullUrl = await toolNames(full, pair.access_token, '/mcp');
    expect(onFullUrl).toContain('log_list');
    expect(onFullUrl).not.toContain('prompt_deploy');
  });

  it('narrows an enterprise read-only sign-in the same way', async () => {
    const broker = new OAuthBroker({ config: loadOAuthConfig(process.env), store: new InMemorySessionStore() });
    const started = await broker.startAuthorization({
      realm: 'enterprise', clientId: 'enc_client', clientName: 'Enterprise read-only', redirectUri: REDIRECT,
      clientState: 'state', codeChallenge: CHALLENGE, resource: 'https://mcp.respan.ai/mcp/enterprise/readonly',
    });
    expect(started.transaction.resource).toBe('https://mcp.respan.ai/mcp/enterprise');
    expect(started.transaction.requestedScope).toBe('mcp:read');
  });

  it('accepts the read-only resource when refreshing', async () => {
    const store = new InMemorySessionStore();
    const config = loadOAuthConfig(process.env);
    const backendRefresh = vi.fn(async () => new Response(
      JSON.stringify({ access: jwt('access-2'), refresh: jwt('refresh-2') }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const broker = new OAuthBroker({ config, store, fetch: backendRefresh });
    const started = await broker.startAuthorization({
      realm: 'platform', clientId: 'enc_client', clientName: 'Refresh test', redirectUri: REDIRECT,
      clientState: 'state', codeChallenge: CHALLENGE, resource: 'https://mcp.respan.ai/mcp/readonly',
    });
    await broker.approveAuthorization('platform', started.transactionToken, started.browserCsrf);
    const redirect = await broker.completeAuthorization({
      realm: 'platform', transactionToken: started.transactionToken, browserCsrf: started.browserCsrf,
      backendAccessJwt: jwt('access'), backendRefreshJwt: jwt('refresh'),
    });
    const pair = await broker.exchangeAuthorizationCode({
      code: new URL(redirect).searchParams.get('code')!, codeVerifier: VERIFIER, clientId: 'enc_client', redirectUri: REDIRECT,
    });
    const refreshed = await broker.refresh({
      refreshToken: pair.refresh_token, clientId: 'enc_client', resource: 'https://mcp.respan.ai/mcp/readonly',
    });
    expect(refreshed.scope).toBe('mcp:read');
  });
});

async function writeGrant(broker: OAuthBroker) {
  const started = await broker.startAuthorization({
    realm: 'platform', clientId: 'enc_client', clientName: 'Write grant', redirectUri: REDIRECT,
    clientState: 'state', codeChallenge: CHALLENGE, resource: 'https://mcp.respan.ai/mcp',
  });
  await broker.approveAuthorization('platform', started.transactionToken, started.browserCsrf, undefined, true);
  const redirect = await broker.completeAuthorization({
    realm: 'platform', transactionToken: started.transactionToken, browserCsrf: started.browserCsrf,
    backendAccessJwt: jwt('access'), backendRefreshJwt: jwt('refresh'),
  });
  return new URL(redirect).searchParams.get('code')!;
}

describe('/mcp/readonly never yields a write token', () => {
  it('refuses to exchange a write code for the read-only resource', async () => {
    const store = new InMemorySessionStore();
    const broker = new OAuthBroker({ config: loadOAuthConfig(process.env), store });
    const code = await writeGrant(broker);
    await expect(broker.exchangeAuthorizationCode({
      code, codeVerifier: VERIFIER, clientId: 'enc_client', redirectUri: REDIRECT,
      resource: 'https://mcp.respan.ai/mcp/readonly',
    })).rejects.toMatchObject({ oauthError: 'invalid_grant' });
  });

  it('refuses to refresh a write session for the read-only resource', async () => {
    const store = new InMemorySessionStore();
    const backendRefresh = vi.fn();
    const broker = new OAuthBroker({ config: loadOAuthConfig(process.env), store, fetch: backendRefresh });
    const pair = await broker.exchangeAuthorizationCode({
      code: await writeGrant(broker), codeVerifier: VERIFIER, clientId: 'enc_client', redirectUri: REDIRECT,
    });
    expect(pair.scope).toBe('mcp:read mcp:write');
    await expect(broker.refresh({
      refreshToken: pair.refresh_token, clientId: 'enc_client', resource: 'https://mcp.respan.ai/mcp/readonly',
    })).rejects.toMatchObject({ oauthError: 'invalid_grant' });
    expect(backendRefresh).not.toHaveBeenCalled();

    // The write session survives on /mcp.
    const full = createMcpHandler('https://api.respan.ai', '/.well-known/oauth-protected-resource', 'platform');
    setSessionStoreForTests(store);
    expect(await toolNames(full, pair.access_token, '/mcp')).toContain('prompt_deploy');
  });

  it('challenges for read scope only on the read-only URL', async () => {
    setSessionStoreForTests(new InMemorySessionStore());
    const saved = process.env.RESPAN_API_KEY;
    delete process.env.RESPAN_API_KEY;
    try {
      const request = rpc('', 'tools/list', {});
      delete request.headers.authorization;
      const response = new MockResponse();
      await readOnlyHandler(request, response as any);
      expect(response.statusCode).toBe(401);
      expect(response.getHeader('www-authenticate')).toBe(
        'Bearer scope="mcp:read", resource_metadata='
          + '"https://mcp.respan.ai/.well-known/oauth-protected-resource/mcp/readonly"',
      );
    } finally {
      if (saved !== undefined) process.env.RESPAN_API_KEY = saved;
    }
  });
});

describe('/mcp/readonly discovery and routing', () => {
  it('publishes its own resource metadata with read scope only', () => {
    const platform = new MockResponse();
    readOnlyResourceMetadata({ method: 'GET' } as any, platform as any);
    expect(platform.body).toEqual({
      resource: 'https://mcp.respan.ai/mcp/readonly',
      authorization_servers: ['https://mcp.respan.ai'],
      scopes_supported: ['mcp:read'],
    });
    const enterprise = new MockResponse();
    enterpriseReadOnlyResourceMetadata({ method: 'GET' } as any, enterprise as any);
    expect(enterprise.body.resource).toBe('https://mcp.respan.ai/mcp/enterprise/readonly');
    expect(enterprise.body.authorization_servers).toEqual(['https://mcp.respan.ai/enterprise-oauth']);
  });

  it('routes the read-only URLs and their metadata on Vercel', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      rewrites: Array<{ source: string; destination: string }>;
      functions: Record<string, unknown>;
    };
    const route = (source: string) => vercel.rewrites.find((rewrite) => rewrite.source === source)?.destination;
    expect(route('/mcp/readonly')).toBe('/api/mcp/readonly');
    expect(route('/mcp/enterprise/readonly')).toBe('/api/mcp/enterprise-readonly');
    expect(route('/.well-known/oauth-protected-resource/mcp/readonly'))
      .toBe('/api/well-known/oauth-protected-resource-readonly');
    expect(route('/.well-known/oauth-protected-resource/mcp/enterprise/readonly'))
      .toBe('/api/well-known/oauth-protected-resource-enterprise-readonly');
    for (const fn of [
      'api/mcp/readonly.ts',
      'api/mcp/enterprise-readonly.ts',
      'api/well-known/oauth-protected-resource-readonly.ts',
      'api/well-known/oauth-protected-resource-enterprise-readonly.ts',
    ]) {
      expect(vercel.functions[fn], fn).toBeDefined();
    }
  });
});
