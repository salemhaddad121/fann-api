import { ExecutionContext, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionGuard } from './subscription.guard';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';
import { UserRole } from '../users/users.types';

const SUBS_TABLE = 'subscriptions as s';

function makeContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler:   () => () => undefined,
    getClass:     () => class {},
  } as unknown as ExecutionContext;
}

function makeDb(subscription: unknown) {
  const subs = createMockQueryBuilder();
  subs.first.mockResolvedValueOnce(subscription);
  return createMockDb({ [SUBS_TABLE]: subs });
}

// `scoped` is what @RequiresSubscription(...) would have set; undefined
// stands for a route that declares no scope at all.
function makeReflector(scoped?: UserRole[]): Reflector {
  return {
    getAllAndOverride: () => scoped,
  } as unknown as Reflector;
}

describe('SubscriptionGuard', () => {
  it('allows a user with an active subscription through', async () => {
    const guard = new SubscriptionGuard(
      makeDb({ id: 'sub-1', plan_code: 'month' }),
      makeReflector(),
    );

    await expect(guard.canActivate(makeContext({ id: 'user-1' }))).resolves.toBe(true);
  });

  it('refuses an unsubscribed user with 402, not 403', async () => {
    // 402 is what tells the frontend to show the upgrade CTA. A 403 would
    // be indistinguishable from "this account is not permitted to do this",
    // which is a different situation with a different fix.
    const guard = new SubscriptionGuard(makeDb(undefined), makeReflector());

    await expect(
      guard.canActivate(makeContext({ id: 'user-1' })),
    ).rejects.toMatchObject({ status: HttpStatus.PAYMENT_REQUIRED });
  });

  it('reports a missing session as unauthorised rather than unsubscribed', async () => {
    // Reaching this guard with no req.user means the route was wired
    // without an auth guard in front. Reporting that as "buy a plan" would
    // send a paying customer off to pay twice.
    const guard = new SubscriptionGuard(makeDb(undefined), makeReflector());

    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('lets a role outside the declared scope through without a subscription', async () => {
    // The case the scope exists for: an artist replying in their own inbox
    // on a route a planner has to pay for. Billing them here would charge
    // artists to answer their own mail.
    const guard = new SubscriptionGuard(makeDb(undefined), makeReflector(['planner']));

    await expect(
      guard.canActivate(makeContext({ id: 'artist-1', role: 'artist' })),
    ).resolves.toBe(true);
  });

  it('still charges a role that IS in the declared scope', async () => {
    const guard = new SubscriptionGuard(makeDb(undefined), makeReflector(['planner']));

    await expect(
      guard.canActivate(makeContext({ id: 'planner-1', role: 'planner' })),
    ).rejects.toMatchObject({ status: HttpStatus.PAYMENT_REQUIRED });
  });

  it('does not consult the database for an out-of-scope role', async () => {
    // Not just an optimisation: the scope check has to come before the
    // lookup, or every artist message costs a subscriptions query.
    const subs = createMockQueryBuilder();
    const db = createMockDb({ [SUBS_TABLE]: subs });
    const guard = new SubscriptionGuard(db, makeReflector(['planner']));

    await guard.canActivate(makeContext({ id: 'artist-1', role: 'artist' }));

    expect(subs.first).not.toHaveBeenCalled();
  });
});
