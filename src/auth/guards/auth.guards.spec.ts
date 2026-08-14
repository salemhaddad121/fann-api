import { OptionalJwtAuthGuard } from './auth.guards';

describe('OptionalJwtAuthGuard.handleRequest()', () => {
  const guard = new OptionalJwtAuthGuard();

  it('passes the user through when a valid session is present', () => {
    const user = { id: 'user-1', role: 'planner' };

    expect(guard.handleRequest(null, user)).toBe(user);
  });

  it('returns null instead of throwing when there is no token', () => {
    // Passport signals "no credentials" by handing back false. On a route
    // that serves guests this is the normal case, not a failure.
    expect(guard.handleRequest(null, false)).toBeNull();
  });

  it('returns null rather than propagating an auth error', () => {
    // An expired or malformed token, or a suspended account, all arrive
    // here as an error. On a guest-friendly route every one of them means
    // the same thing: serve the guest view. Letting any of them through as
    // a 401 would break public browsing for anyone holding a stale cookie
    // — which is exactly the visitor most likely to sign up.
    expect(
      guard.handleRequest(new Error('jwt expired'), false),
    ).toBeNull();
  });
});
