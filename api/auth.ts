import type { VercelRequest, VercelResponse } from '@vercel/node';

const DEFAULT_BASE_URL = 'https://api.respan.ai/api';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { action, email, password, refresh, redirect_uri, code, state, _backend_cookies } = req.body ?? {};

  const validActions = ['login', 'refresh', 'google_url', 'google_jwt'];
  if (!action || !validActions.includes(action)) {
    return res.status(400).json({ error: `Invalid action. Use one of: ${validActions.join(', ')}` });
  }

  const baseUrl = (req.headers['respan-api-base-url'] as string)
    || (req.headers['keywords-api-base-url'] as string)
    || process.env.RESPAN_API_BASE_URL
    || DEFAULT_BASE_URL;

  // Strip trailing /api if present so we can build the auth URL correctly.
  // The JWT endpoints live at /auth/jwt/... which is outside the /api/ prefix.
  const origin = baseUrl.replace(/\/api\/?$/, '');

  // --- Google OAuth: get authorization URL ---
  if (action === 'google_url') {
    if (!redirect_uri) {
      return res.status(400).json({ error: 'redirect_uri is required for google_url.' });
    }
    const url = `${origin}/auth/o/google-oauth2/?redirect_uri=${encodeURIComponent(redirect_uri)}`;
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'manual' });
      // Capture backend cookies (session + CSRF) needed for the token exchange step
      const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
      const backendCookies = setCookieHeaders.map(c => c.split(';')[0]).join('; ');
      const data = await response.json() as Record<string, unknown>;
      return res.status(response.status).json({ ...data, _backend_cookies: backendCookies });
    } catch (error) {
      console.error('Auth proxy error:', error);
      return res.status(502).json({ error: 'Failed to reach authentication backend.' });
    }
  }

  // --- Google OAuth: exchange code for JWT ---
  if (action === 'google_jwt') {
    if (!code || !state) {
      return res.status(400).json({ error: 'code and state are required for google_jwt.' });
    }
    const params = new URLSearchParams({ code, state });
    const url = `${origin}/auth/o/google-oauth2/?${params}`;
    try {
      // Extract CSRF token from backend cookies if available
      const csrfMatch = (_backend_cookies || '').match(/csrftoken=([^;,\s]+)/);
      const csrfToken = csrfMatch ? csrfMatch[1] : '';
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      if (_backend_cookies) headers['Cookie'] = _backend_cookies;
      if (csrfToken) headers['X-CSRFToken'] = csrfToken;

      const response = await fetch(url, { method: 'POST', headers });
      const data = await response.json();
      return res.status(response.status).json(data);
    } catch (error) {
      console.error('Auth proxy error:', error);
      return res.status(502).json({ error: 'Failed to reach authentication backend.' });
    }
  }

  // --- Email/password login or token refresh ---
  let backendUrl: string;
  let body: Record<string, string>;

  if (action === 'login') {
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required for login.' });
    }
    backendUrl = `${origin}/auth/jwt/create/`;
    body = { email, password };
  } else {
    if (!refresh) {
      return res.status(400).json({ error: 'refresh token is required for refresh.' });
    }
    backendUrl = `${origin}/auth/jwt/refresh/`;
    body = { refresh };
  }

  try {
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Auth proxy error:', error);
    return res.status(502).json({ error: 'Failed to reach authentication backend.' });
  }
}
