import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { RespanClient } from '@respan/respan-api';

export interface AuthConfig {
  token: string;
  baseUrl?: string;
}

export interface AuthenticatedClient {
  client: RespanClient;
  auth: string; // "Bearer <token>"
  baseUrl: string; // For endpoints not yet in the SDK
  // Used by rawFetch when set, so the hosted handler can see a backend 401 on
  // raw calls too and send the OAuth client back through login.
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.respan.ai';

export function createClient(auth: AuthConfig, baseUrl?: string): AuthenticatedClient {
  const resolvedBaseUrl = baseUrl || auth.baseUrl || DEFAULT_BASE_URL;
  return {
    client: new RespanClient({ environment: resolvedBaseUrl }),
    auth: `Bearer ${auth.token}`,
    baseUrl: resolvedBaseUrl,
  };
}

/** True when rawFetch failed with a 401: the backend did not accept the caller's credentials. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof Error && /^401\b/.test(error.message);
}

/** What the agent can do about a failed backend call, by HTTP status. */
export const NEXT_STEP_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'Fix the arguments the error names and call again. tool_search with "select:<tool name>" returns the full input schema.',
  401: 'Respan did not accept the credential. With OAuth, sign in again. With an API key, check it under Settings > API keys; if other tools work with the same key, this tool needs an OAuth sign-in instead.',
  403: 'The credential cannot do this. Check that the API key is valid, not expired and allowed to make this change (Settings > API keys), or that the signed-in user has the role it needs.',
  404: 'Nothing with that id exists in the current project. Get a valid id from the matching *_list tool. Ids from another project are not visible here; with OAuth, project_list shows your other projects.',
  409: 'This conflicts with the current state, such as a duplicate name or a concurrent change. Read the current record with its *_get tool, then call again.',
  429: 'Rate limited. Wait, then call again once. Summary tools and smaller pages need fewer calls.',
};
/** Starts the line rawFetch appends to an error message. */
export const NEXT_STEP_PREFIX = '\nNext step: ';
const NEXT_STEP_SERVER_ERROR = 'Respan failed on its side. Call again once; if it fails again, narrow the time range or page size, and report the time of the call to Respan support.';

/** `message` without the next step rawFetch appended, for callers that explain the error themselves. */
export function withoutNextStep(message: string): string {
  const index = message.indexOf(NEXT_STEP_PREFIX);
  return index === -1 ? message : message.slice(0, index);
}

/** The next step for a failed call, or undefined for statuses with none. */
export function nextStepFor(status: number, retryAfter?: string | null): string | undefined {
  if (status >= 500) return NEXT_STEP_SERVER_ERROR;
  const step = NEXT_STEP_BY_STATUS[status];
  // Retry-After may also be an HTTP date; only seconds read as a wait.
  if (status === 429 && step && retryAfter && /^\d+$/.test(retryAfter.trim())) {
    return `${step} Retry after ${retryAfter.trim()} seconds.`;
  }
  return step;
}

/**
 * Raw fetch helper for endpoints not yet in the SDK.
 * Throws on non-2xx with the response body included, then a line saying
 * what to do next. The message keeps its leading status (isUnauthorized).
 */
export async function rawFetch(
  client: AuthenticatedClient,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<unknown> {
  const parsedUrl = new URL(path, client.baseUrl);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined) parsedUrl.searchParams.set(key, String(value));
  }
  const url = parsedUrl.toString();
  const res = await (client.fetch ?? fetch)(url, {
    method: init.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: client.auth,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const step = nextStepFor(res.status, res.headers.get('retry-after'));
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw Object.assign(
      new Error(`${res.status} ${res.statusText}: ${detail}${step ? `${NEXT_STEP_PREFIX}${step}` : ''}`),
      { status: res.status },
    );
  }
  return parsed;
}

/**
 * Read credentials from ~/.respan/credentials.json (written by `respan login`).
 * Returns the active profile's token and baseUrl, or null if not available.
 */
function resolveAuthFromCredentialFile(): AuthConfig | null {
  try {
    const configDir = join(homedir(), '.respan');

    // Read active profile from config.json
    let activeProfile = 'default';
    try {
      const configRaw = readFileSync(join(configDir, 'config.json'), 'utf-8');
      const config = JSON.parse(configRaw);
      if (config.activeProfile) {
        activeProfile = config.activeProfile;
      }
    } catch {
      // No config file or invalid — use default profile
    }

    // Read credentials.json
    const credsRaw = readFileSync(join(configDir, 'credentials.json'), 'utf-8');
    const creds = JSON.parse(credsRaw);
    const credential = creds[activeProfile];
    if (!credential) return null;

    // Support both api_key and jwt credential types
    let token: string | undefined;
    if (credential.type === 'api_key' && credential.apiKey) {
      token = credential.apiKey;
    } else if (credential.type === 'jwt' && credential.accessToken) {
      token = credential.accessToken;
    }

    if (!token) return null;

    return {
      token,
      baseUrl: credential.baseUrl || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve auth from environment variables or credential file.
 * Priority: env var > credential file
 */
export function resolveAuthFromEnv(): AuthConfig | null {
  // 1. Environment variable (highest priority)
  const envToken = process.env.RESPAN_API_KEY;
  if (envToken) {
    return {
      token: envToken,
      baseUrl: process.env.RESPAN_API_BASE_URL || undefined,
    };
  }

  // 2. Credential file (~/.respan/credentials.json, written by `respan login`)
  return resolveAuthFromCredentialFile();
}

export function requireClient(client: AuthenticatedClient | null): AuthenticatedClient {
  if (!client) {
    throw new Error(
      'This tool requires authentication. Set RESPAN_API_KEY or run `respan login` to authenticate.'
    );
  }
  return client;
}
