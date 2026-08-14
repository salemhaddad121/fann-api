import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

// getActiveSubscription() joins, so it addresses the table by its alias.
const ACTIVE_LOOKUP = 'subscriptions as s';

const DAY_PLAN = { code: 'day', price_usd: '5.00', duration_days: 1, requires_id_doc: false, message_cap: 15 };
const MONTH_PLAN = { code: 'month', price_usd: '15.00', duration_days: 30, requires_id_doc: true, message_cap: null };
const YEAR_PLAN = { code: 'year', price_usd: '100.00', duration_days: 365, requires_id_doc: true, message_cap: null };

function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    planner_id: 'user-1',
    plan_code: 'month',
    quantity: 1,
    amount_usd: '15.00',
    status: 'confirmed',
    ...overrides,
  };
}

describe('SubscriptionsService.mintForPayment()', () => {
  it('mints day passes as unactivated credits, one per unit bought', async () => {
    // Day access is sold as credits precisely because confirmation is not
    // instant — the buyer starts each 24h clock when they need it.
    const payments = createMockQueryBuilder();
    payments.first.mockResolvedValueOnce(makePayment({ plan_code: 'day', quantity: 3 }));
    const plans = createMockQueryBuilder();
    plans.first.mockResolvedValueOnce(DAY_PLAN);
    const subs = createMockQueryBuilder();
    subs.mockResolve([]); // nothing minted for this payment yet
    subs.returning.mockResolvedValueOnce([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);

    const db = createMockDb({ payments, subscription_plans: plans, subscriptions: subs });
    const service = new SubscriptionsService(db);

    const result = await service.mintForPayment('pay-1');

    expect(result.minted).toBe(3);
    const inserted = subs.insert.mock.calls[0][0];
    expect(inserted).toHaveLength(3);
    expect(inserted.every((r: any) => r.status === 'ready')).toBe(true);
  });

  it('starts a month immediately when nothing is running', async () => {
    const payments = createMockQueryBuilder();
    payments.first.mockResolvedValueOnce(makePayment());
    const plans = createMockQueryBuilder();
    plans.first.mockResolvedValueOnce(MONTH_PLAN);
    const subs = createMockQueryBuilder();
    subs.mockResolve([]);
    subs.first.mockResolvedValueOnce(undefined); // no active subscription
    subs.returning.mockResolvedValueOnce([
      { id: 's1', status: 'active', expires_at: new Date('2026-09-14') },
    ]);
    const chain = createMockQueryBuilder();
    chain.mockResolve([]); // no queued rows

    const db = createMockDb({
      payments,
      subscription_plans: plans,
      subscriptions: subs,
      [ACTIVE_LOOKUP]: chain,
    });
    const service = new SubscriptionsService(db);

    await service.mintForPayment('pay-1');

    expect(subs.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', plan_code: 'month' }),
    );
  });

  it('queues a purchase behind a running subscription, leaving expires_at unset', async () => {
    // This is the heart of stacking. expires_at must stay NULL until
    // promotion, so that an early cancellation or an admin adjustment
    // shifts the whole chain instead of leaving a stale date behind.
    const payments = createMockQueryBuilder();
    payments.first.mockResolvedValueOnce(makePayment({ plan_code: 'year' }));
    const plans = createMockQueryBuilder();
    plans.first.mockResolvedValueOnce(YEAR_PLAN);
    const subs = createMockQueryBuilder();
    subs.mockResolve([]);
    subs.first.mockResolvedValueOnce({
      id: 'active-1',
      status: 'active',
      expires_at: new Date('2026-09-14T00:00:00Z'),
    });
    subs.returning.mockResolvedValueOnce([{ id: 's2', status: 'queued' }]);
    const chain = createMockQueryBuilder();
    chain.mockResolve([]);

    const db = createMockDb({
      payments,
      subscription_plans: plans,
      subscriptions: subs,
      [ACTIVE_LOOKUP]: chain,
    });
    const service = new SubscriptionsService(db);

    await service.mintForPayment('pay-1');

    const inserted = subs.insert.mock.calls[0][0];
    expect(inserted.status).toBe('queued');
    expect(inserted.expires_at).toBeNull();
    // Projected start is the end of what is currently running.
    expect(new Date(inserted.starts_at).toISOString()).toBe('2026-09-14T00:00:00.000Z');
  });

  it('refuses to mint a second time for the same payment', async () => {
    // Payment providers retry webhooks. Without this a retry hands out a
    // second year for one payment.
    const payments = createMockQueryBuilder();
    payments.first.mockResolvedValueOnce(makePayment());
    const subs = createMockQueryBuilder();
    subs.mockResolve([{ id: 'already-minted' }]);

    const db = createMockDb({ payments, subscriptions: subs });
    const service = new SubscriptionsService(db);

    const result = await service.mintForPayment('pay-1');

    expect(result.alreadyMinted).toBe(true);
    expect(result.minted).toBe(0);
    expect(subs.insert).not.toHaveBeenCalled();
  });

  it('treats a pre-subscription payment as nothing to mint, not an error', async () => {
    // Seed payments from migration 009 predate plan_code.
    const payments = createMockQueryBuilder();
    payments.first.mockResolvedValueOnce(makePayment({ plan_code: null }));
    const db = createMockDb({ payments });
    const service = new SubscriptionsService(db);

    await expect(service.mintForPayment('pay-1')).resolves.toEqual({
      minted: 0,
      alreadyMinted: false,
      rows: [],
    });
  });
});

describe('SubscriptionsService.activate()', () => {
  it('refuses to burn a credit while a paid plan is already running', async () => {
    // Access is not additive — a running month already unlocks everything
    // a day pass would, so spending one now would waste it.
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce({ id: 'credit-1', user_id: 'user-1', status: 'ready', plan_code: 'day' });
    const chain = createMockQueryBuilder();
    chain.first.mockResolvedValueOnce({ id: 'active-1', plan_code: 'month' });

    const db = createMockDb({ subscriptions: subs, [ACTIVE_LOOKUP]: chain });
    const service = new SubscriptionsService(db);

    await expect(service.activate('user-1', 'credit-1')).rejects.toBeInstanceOf(ConflictException);
    expect(subs.update).not.toHaveBeenCalled();
  });

  it('refuses a credit that is not in ready state', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce({ id: 'c1', user_id: 'user-1', status: 'expired', plan_code: 'day' });
    const db = createMockDb({ subscriptions: subs });
    const service = new SubscriptionsService(db);

    await expect(service.activate('user-1', 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a credit belonging to someone else', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce(undefined);
    const db = createMockDb({ subscriptions: subs });
    const service = new SubscriptionsService(db);

    await expect(service.activate('user-1', 'c1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('starts the clock and reports the new expiry', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce({ id: 'c1', user_id: 'user-1', status: 'ready', plan_code: 'day' });
    subs.returning.mockResolvedValueOnce([
      { id: 'c1', status: 'active', expires_at: new Date('2026-08-16') },
    ]);
    const plans = createMockQueryBuilder();
    plans.first.mockResolvedValueOnce(DAY_PLAN);
    const chain = createMockQueryBuilder();
    chain.first.mockResolvedValueOnce(undefined); // nothing running

    const db = createMockDb({ subscriptions: subs, subscription_plans: plans, [ACTIVE_LOOKUP]: chain });
    const service = new SubscriptionsService(db);

    const result = await service.activate('user-1', 'c1');

    expect(result.status).toBe('active');
    // Conditional update: status must be in the WHERE clause so two
    // simultaneous requests cannot both spend the same credit.
    expect(subs.where).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', user_id: 'user-1', status: 'ready' }),
    );
  });

  it('reports a lost activation race as a conflict, not a crash', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce({ id: 'c1', user_id: 'user-1', status: 'ready', plan_code: 'day' });
    subs.returning.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const plans = createMockQueryBuilder();
    plans.first.mockResolvedValueOnce(DAY_PLAN);
    const chain = createMockQueryBuilder();
    chain.first.mockResolvedValueOnce(undefined);

    const db = createMockDb({ subscriptions: subs, subscription_plans: plans, [ACTIVE_LOOKUP]: chain });
    const service = new SubscriptionsService(db);

    await expect(service.activate('user-1', 'c1')).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('SubscriptionsService.createPaymentIntent()', () => {
  it('prices the purchase from the plan table, not from the request', async () => {
    // Otherwise a buyer can name their own price.
    const plans = createMockQueryBuilder();
    plans.first.mockResolvedValueOnce(MONTH_PLAN);
    const payments = createMockQueryBuilder();
    payments.returning.mockResolvedValueOnce([
      { id: 'pay-1', plan_code: 'month', quantity: 2, amount_usd: '30.00' },
    ]);
    const users = createMockQueryBuilder();
    users.first.mockResolvedValueOnce({ account_code: 'PLN-000042' });

    const db = createMockDb({ subscription_plans: plans, payments, users });
    const service = new SubscriptionsService(db);

    const result = await service.createPaymentIntent('user-1', {
      planCode: 'month',
      quantity: 2,
    } as any);

    expect(payments.insert).toHaveBeenCalledWith(
      expect.objectContaining({ amount_usd: 30, quantity: 2, status: 'pending' }),
    );
    // NUMERIC comes back from node-postgres as a string; it must not reach
    // the frontend that way or arithmetic on it silently concatenates.
    expect(result.amount_usd).toBe(30);
    // The reconciliation key the buyer has to quote on the transfer.
    expect(result.account_code).toBe('PLN-000042');
  });

  it('leaves period_start and period_end unset', async () => {
    // A purchase has no period until the subscription it buys is activated.
    const plans = createMockQueryBuilder();
    plans.first.mockResolvedValueOnce(DAY_PLAN);
    const payments = createMockQueryBuilder();
    payments.returning.mockResolvedValueOnce([{ id: 'pay-1', amount_usd: '5.00' }]);
    const users = createMockQueryBuilder();
    users.first.mockResolvedValueOnce({ account_code: 'PLN-1' });

    const db = createMockDb({ subscription_plans: plans, payments, users });
    const service = new SubscriptionsService(db);

    await service.createPaymentIntent('user-1', { planCode: 'day' } as any);

    const inserted = payments.insert.mock.calls[0][0];
    expect(inserted.period_start).toBeUndefined();
    expect(inserted.period_end).toBeUndefined();
  });

  it('rejects a plan that is not on sale', async () => {
    const plans = createMockQueryBuilder();
    plans.first.mockResolvedValueOnce(undefined);
    const db = createMockDb({ subscription_plans: plans });
    const service = new SubscriptionsService(db);

    await expect(
      service.createPaymentIntent('user-1', { planCode: 'year' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SubscriptionsService.findDueRenewalReminders()', () => {
  it('never reminds about a day pass', async () => {
    // There is no useful warning window inside 24 hours.
    const chain = createMockQueryBuilder();
    chain.mockResolve([
      { id: 's1', user_id: 'u1', plan_code: 'day', expires_at: new Date(Date.now() + 3_600_000) },
    ]);
    const db = createMockDb({ [ACTIVE_LOOKUP]: chain });
    const service = new SubscriptionsService(db);

    await expect(service.findDueRenewalReminders()).resolves.toEqual([]);
  });

  it('skips a reminder the user has already been sent', async () => {
    const expires = new Date(Date.now() + 6 * 86_400_000); // 6 days out → 7-day threshold
    const chain = createMockQueryBuilder();
    chain.mockResolve([{ id: 's1', user_id: 'u1', plan_code: 'year', expires_at: expires }]);
    const notifications = createMockQueryBuilder();
    notifications.mockResolve([{ data: { subscription_id: 's1', days: 7 } }]);

    const db = createMockDb({ [ACTIVE_LOOKUP]: chain, notifications });
    const service = new SubscriptionsService(db);

    await expect(service.findDueRenewalReminders()).resolves.toEqual([]);
  });

  it('returns a due reminder that has not been sent yet', async () => {
    const expires = new Date(Date.now() + 6 * 86_400_000);
    const chain = createMockQueryBuilder();
    chain.mockResolve([{ id: 's1', user_id: 'u1', plan_code: 'year', expires_at: expires }]);
    const notifications = createMockQueryBuilder();
    notifications.mockResolve([]);

    const db = createMockDb({ [ACTIVE_LOOKUP]: chain, notifications });
    const service = new SubscriptionsService(db);

    const due = await service.findDueRenewalReminders();

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ subscription_id: 's1', days: 7 });
  });
});
