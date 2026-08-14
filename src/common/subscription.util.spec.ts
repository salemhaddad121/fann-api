import {
  ActiveSubscription,
  getActiveSubscription,
  hasActiveSubscription,
} from './subscription.util';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

// The util joins, so it addresses the table by its aliased name. The mock
// resolves builders by the exact string passed to db(), hence the alias here.
const SUBS_TABLE = 'subscriptions as s';

function makeSubscription(
  overrides: Partial<ActiveSubscription> = {},
): ActiveSubscription {
  return {
    id: 'sub-1',
    user_id: 'user-1',
    plan_code: 'month',
    status: 'active',
    activated_at: new Date(),
    starts_at: new Date(),
    expires_at: new Date(Date.now() + 86_400_000),
    requires_id_doc: true,
    message_cap: null,
    ...overrides,
  };
}

describe('getActiveSubscription()', () => {
  it('returns the subscription joined to its plan policy flags', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce(
      makeSubscription({ plan_code: 'day', requires_id_doc: false, message_cap: 15 }),
    );
    const db = createMockDb({ [SUBS_TABLE]: subs });

    const result = await getActiveSubscription(db, 'user-1');

    expect(result?.plan_code).toBe('day');
    // The plan's policy flags must come back with the subscription: callers
    // branch on these rather than on the plan name.
    expect(result?.requires_id_doc).toBe(false);
    expect(result?.message_cap).toBe(15);
  });

  it('returns undefined when the user has no active subscription', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce(undefined);
    const db = createMockDb({ [SUBS_TABLE]: subs });

    expect(await getActiveSubscription(db, 'user-1')).toBeUndefined();
  });

  it('filters on the user and on active status', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce(undefined);
    const db = createMockDb({ [SUBS_TABLE]: subs });

    await getActiveSubscription(db, 'user-42');

    expect(subs.where).toHaveBeenCalledWith('s.user_id', 'user-42');
    expect(subs.where).toHaveBeenCalledWith('s.status', 'active');
  });

  it('verifies the expiry timestamp instead of trusting status alone', async () => {
    // A subscription's status is flipped to 'expired' by a cron job, so
    // between lapsing and the next run a row can still read 'active' with
    // the clock already run out. Without this check that window is free
    // access. The comparison must also use the database clock, not Node's,
    // because the scheduler writing these rows uses the database clock.
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce(undefined);
    const db = createMockDb({ [SUBS_TABLE]: subs });

    await getActiveSubscription(db, 'user-1');

    expect(subs.whereRaw).toHaveBeenCalledWith('s.expires_at > now()');
  });
});

describe('hasActiveSubscription()', () => {
  it('is true when a subscription comes back', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce(makeSubscription());
    const db = createMockDb({ [SUBS_TABLE]: subs });

    expect(await hasActiveSubscription(db, 'user-1')).toBe(true);
  });

  it('is false when none does', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce(undefined);
    const db = createMockDb({ [SUBS_TABLE]: subs });

    expect(await hasActiveSubscription(db, 'user-1')).toBe(false);
  });
});
