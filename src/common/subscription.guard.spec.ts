import { ExecutionContext, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { SubscriptionGuard } from './subscription.guard';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

const SUBS_TABLE = 'subscriptions as s';

function makeContext(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function makeDb(subscription: unknown) {
  const subs = createMockQueryBuilder();
  subs.first.mockResolvedValueOnce(subscription);
  return createMockDb({ [SUBS_TABLE]: subs });
}

describe('SubscriptionGuard', () => {
  it('allows a user with an active subscription through', async () => {
    const guard = new SubscriptionGuard(makeDb({ id: 'sub-1', plan_code: 'month' }));

    await expect(guard.canActivate(makeContext({ id: 'user-1' }))).resolves.toBe(true);
  });

  it('refuses an unsubscribed user with 402, not 403', async () => {
    // 402 is what tells the frontend to show the upgrade CTA. A 403 would
    // be indistinguishable from "this account is not permitted to do this",
    // which is a different situation with a different fix.
    const guard = new SubscriptionGuard(makeDb(undefined));

    await expect(
      guard.canActivate(makeContext({ id: 'user-1' })),
    ).rejects.toMatchObject({ status: HttpStatus.PAYMENT_REQUIRED });
  });

  it('reports a missing session as unauthorised rather than unsubscribed', async () => {
    // Reaching this guard with no req.user means the route was wired
    // without an auth guard in front. Reporting that as "buy a plan" would
    // send a paying customer off to pay twice.
    const guard = new SubscriptionGuard(makeDb(undefined));

    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
