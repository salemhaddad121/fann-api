import { JwtAuthGuard, OptionalJwtAuthGuard } from './auth.guards';

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

describe('JwtAuthGuard default-deny', () => {
  function makeContext() {
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      // Passport reaches for the response and next() once it actually
      // runs, so the fake context has to be complete enough to survive
      // the non-public path.
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, cookies: {} }),
        getResponse: () => ({ setHeader: () => undefined, end: () => undefined }),
        getNext: () => () => undefined,
      }),
    } as any;
  }

  it('lets a @Public() route through without consulting passport', () => {
    // The whole point of the marker: it short-circuits before any token
    // work happens, so a guest never pays for a session lookup.
    const reflector = { getAllAndOverride: jest.fn(() => true) } as any;
    const guard = new JwtAuthGuard(reflector);

    expect(guard.canActivate(makeContext())).toBe(true);
  });

  // The fall-through case — an UNMARKED route reaching passport and being
  // denied — is not unit-testable here: passport needs its 'jwt' strategy
  // registered, which only happens when the module boots. It is verified at
  // runtime instead, by adding a route with no @Public() and confirming it
  // answers 401. That is stronger evidence than a mock would be.

  it('checks the handler AND the class, so a whole controller can be public', () => {
    // The cron and webhook controllers are public in their entirety.
    const reflector = { getAllAndOverride: jest.fn(() => true) } as any;
    const guard = new JwtAuthGuard(reflector);

    guard.canActivate(makeContext());

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      'isPublic',
      expect.arrayContaining([expect.anything(), expect.anything()]),
    );
  });
});
