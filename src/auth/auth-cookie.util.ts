import { Response } from 'express';

// Single source of truth for the two auth cookie names, so the strategy
// that reads them and the controller that sets/clears them can't drift.
export const ACCESS_TOKEN_COOKIE = 'accessToken';
export const REFRESH_TOKEN_COOKIE = 'refreshToken';

const ACCESS_TOKEN_MAX_AGE_MS = 15 * 60 * 1000;        // 15 minutes — matches JWT_SECRET-signed token expiry
const REFRESH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches JWT_REFRESH_SECRET-signed token expiry

// The API and web app are expected to live on the same site (e.g. same
// registrable domain, whether that's `localhost` on two ports in dev, or
// `app.aynu.com` / `api.aynu.com` subdomains in production) — SameSite is
// based on registrable domain, not port or subdomain, so both of those
// count as "same-site" and `Lax` cookies flow normally between them.
//
// `Lax` also already blocks the classic CSRF vectors (a cross-site page
// can't trigger a cookie-authenticated POST/PUT/DELETE against this API),
// and there are no cross-site form posts anywhere in this app, so a
// separate CSRF token isn't added on top of it right now. If the frontend
// and backend ever end up on genuinely unrelated domains instead of a
// shared parent domain, this needs revisiting — `SameSite=None` would be
// required for cross-site cookies to be sent at all, and `None` does NOT
// give CSRF protection on its own, so a real CSRF token would become
// necessary at that point.
const COOKIE_SAMESITE = 'lax' as const;

// `Secure` cookies are dropped by browsers over plain HTTP, which is what
// local dev uses — so only require it once actually deployed over HTTPS.
const isProd = process.env.NODE_ENV === 'production';

export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
): void {
  res.cookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: COOKIE_SAMESITE,
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
    path: '/',
  });

  res.cookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: COOKIE_SAMESITE,
    maxAge: REFRESH_TOKEN_MAX_AGE_MS,
    // Narrower path: this cookie only ever needs to be sent to the auth
    // endpoints (refresh/logout), so it isn't attached to every other
    // request the way the access token cookie has to be.
    path: '/api/v1/auth',
  });
}

export function setAccessTokenCookie(res: Response, accessToken: string): void {
  res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: COOKIE_SAMESITE,
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
    path: '/',
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/api/v1/auth' });
}
