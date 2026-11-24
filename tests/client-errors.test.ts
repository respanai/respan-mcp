import { describe, expect, it } from 'vitest';
import { NEXT_STEP_BY_STATUS, isUnauthorized, nextStepFor, rawFetch } from '../lib/shared/client.js';

function clientAnswering(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    auth: 'Bearer x',
    baseUrl: 'https://api.respan.ai',
    fetch: async () => new Response(body, { status, statusText: 'Status', headers }),
  } as any;
}

async function errorOf(status: number, body = '{"detail":"nope"}', headers: Record<string, string> = {}): Promise<Error> {
  return rawFetch(clientAnswering(status, body, headers), '/api/x').then(
    () => { throw new Error('expected a failure'); },
    (thrown: unknown) => thrown as Error,
  );
}

describe('backend errors say what to do next', () => {
  it('keeps the status and body first, then the next step', async () => {
    const error = await errorOf(404);
    expect(error.message.split('\n')[0]).toBe('404 Status: {"detail":"nope"}');
    expect(error.message).toContain(`Next step: ${NEXT_STEP_BY_STATUS[404]}`);
  });

  it('still reads as unauthorized for the OAuth re-login', async () => {
    expect(isUnauthorized(await errorOf(401))).toBe(true);
  });

  it('gives every common failure a step', () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500, 502, 503]) {
      expect(nextStepFor(status), String(status)).toBeTruthy();
    }
    expect(nextStepFor(418)).toBeUndefined();
  });

  it('passes Retry-After on to a rate-limited caller', async () => {
    const error = await errorOf(429, '{"detail":"slow down"}', { 'Retry-After': '12' });
    expect(error.message).toContain('Retry after 12 seconds.');
  });

  it('adds no step to a status it has none for', async () => {
    expect((await errorOf(418)).message).not.toContain('Next step');
  });
});
