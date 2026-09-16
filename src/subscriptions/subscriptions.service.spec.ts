import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

// Intent creation asks the registry which provider is active. These tests
// are about the subscription rules, so it is stubbed to the manual
// provider — the one that issues instructions and no redirect.
const registryStub = {
  active: () => ({
    code: 'manual',
    createIntent: async ({ paymentId }: { paymentId: string }) => ({
      providerRef: paymentId,
      instructions: 'Transfer the amount and quote your code.',
    }),
  }),
} as any;

// VAT is read from config. Default the stub to NO rate so every existing
// test keeps asserting the pre-VAT arithmetic it was written for; the VAT
// tests below pass their own rate explicitly.
const configStub = (vatRate?: string) =>
  ({ get: (key: string) => (key === 'VAT_RATE' ? vatRate : undefined) }) as any;

const noVat = configStub('0');

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
    const service = new SubscriptionsService(db, registryStub, noVat);

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
    const service = new SubscriptionsService(db, registryStub, noVat);

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
    const service = new SubscriptionsService(db, registryStub, noVat);

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
    const service = new SubscriptionsService(db, registryStub, noVat);

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
    const service = new SubscriptionsService(db, registryStub, noVat);

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
    const service = new SubscriptionsService(db, registryStub, noVat);

    await expect(service.activate('user-1', 'credit-1')).rejects.toBeInstanceOf(ConflictException);
    expect(subs.update).not.toHaveBeenCalled();
  });

  it('refuses a credit that is not in ready state', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce({ id: 'c1', user_id: 'user-1', status: 'expired', plan_code: 'day' });
    const db = createMockDb({ subscriptions: subs });
    const service = new SubscriptionsService(db, registryStub, noVat);

    await expect(service.activate('user-1', 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a credit belonging to someone else', async () => {
    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce(undefined);
    const db = createMockDb({ subscriptions: subs });
    const service = new SubscriptionsService(db, registryStub, noVat);

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
    const service = new SubscriptionsService(db, registryStub, noVat);

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
    const service = new SubscriptionsService(db, registryStub, noVat);

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
    const service = new SubscriptionsService(db, registryStub, noVat);

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
    const service = new SubscriptionsService(db, registryStub, noVat);

    await service.createPaymentIntent('user-1', { planCode: 'day' } as any);

    const inserted = payments.insert.mock.calls[0][0];
    expect(inserted.period_start).toBeUndefined();
    expect(inserted.period_end).toBeUndefined();
  });

  it('rejects a plan that is not on sale', async () => {
    const plans = createMockQueryBuilder();
    plans.first.mockResolvedValueOnce(undefined);
    const db = createMockDb({ subscription_plans: plans });
    const service = new SubscriptionsService(db, registryStub, noVat);

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
    const service = new SubscriptionsService(db, registryStub, noVat);

    await expect(service.findDueRenewalReminders()).resolves.toEqual([]);
  });

  it('skips a reminder the user has already been sent', async () => {
    const expires = new Date(Date.now() + 6 * 86_400_000); // 6 days out → 7-day threshold
    const chain = createMockQueryBuilder();
    chain.mockResolve([{ id: 's1', user_id: 'u1', plan_code: 'year', expires_at: expires }]);
    const notifications = createMockQueryBuilder();
    notifications.mockResolve([{ data: { subscription_id: 's1', days: 7 } }]);

    const db = createMockDb({ [ACTIVE_LOOKUP]: chain, notifications });
    const service = new SubscriptionsService(db, registryStub, noVat);

    await expect(service.findDueRenewalReminders()).resolves.toEqual([]);
  });

  it('returns a due reminder that has not been sent yet', async () => {
    const expires = new Date(Date.now() + 6 * 86_400_000);
    const chain = createMockQueryBuilder();
    chain.mockResolve([{ id: 's1', user_id: 'u1', plan_code: 'year', expires_at: expires }]);
    const notifications = createMockQueryBuilder();
    notifications.mockResolve([]);

    const db = createMockDb({ [ACTIVE_LOOKUP]: chain, notifications });
    const service = new SubscriptionsService(db, registryStub, noVat);

    const due = await service.findDueRenewalReminders();

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ subscription_id: 's1', days: 7 });
  });
});

describe('SubscriptionsService.createPaymentIntent() — VAT', () => {
  function setUp(vatRate: string, plan: Record<string, unknown> = MONTH_PLAN) {
    const plans = createMockQueryBuilder();
    plans.first.mockResolvedValueOnce(plan);
    const payments = createMockQueryBuilder();
    payments.returning.mockResolvedValueOnce([
      { id: 'pay-1', plan_code: plan.code, quantity: 1, subtotal_usd: '0', vat_rate: '0', vat_usd: '0', amount_usd: '0' },
    ]);
    const users = createMockQueryBuilder();
    users.first.mockResolvedValueOnce({ account_code: 'PLN-000042' });

    const db = createMockDb({ subscription_plans: plans, payments, users });
    return {
      service: new SubscriptionsService(db, registryStub, configStub(vatRate)),
      payments,
    };
  }

  it('charges the gross amount, not the advertised net', async () => {
    // The published price is ex-VAT, so the figure owed is larger than the
    // one on the plan card. amount_usd has always meant "what is owed".
    const { service, payments } = setUp('0.11');

    await service.createPaymentIntent('user-1', { planCode: 'month', quantity: 1 } as any);

    expect(payments.insert).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal_usd: 15, vat_rate: 0.11, vat_usd: 1.65, amount_usd: 16.65 }),
    );
  });

  it('multiplies before taxing, so quantity does not compound rounding', async () => {
    // 3 day passes: 15.00 net, 1.65 tax. Taxing each pass and summing would
    // round three times and can drift from the single-line figure.
    const { service, payments } = setUp('0.11', DAY_PLAN);

    await service.createPaymentIntent('user-1', { planCode: 'day', quantity: 3 } as any);

    expect(payments.insert).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal_usd: 15, vat_usd: 1.65, amount_usd: 16.65 }),
    );
  });

  it('stores the rate on the row, so a later rate change cannot rewrite it', async () => {
    const { service, payments } = setUp('0.11');

    await service.createPaymentIntent('user-1', { planCode: 'month', quantity: 1 } as any);

    expect(payments.insert.mock.calls[0][0].vat_rate).toBe(0.11);
  });

  it('charges exactly the net amount when VAT is held off', async () => {
    // VAT_RATE=0 is the switch for "not registered yet". Nothing extra is
    // charged and the stored rate says so.
    const { service, payments } = setUp('0');

    await service.createPaymentIntent('user-1', { planCode: 'month', quantity: 1 } as any);

    expect(payments.insert).toHaveBeenCalledWith(
      expect.objectContaining({ subtotal_usd: 15, vat_rate: 0, vat_usd: 0, amount_usd: 15 }),
    );
  });

  it('does not charge VAT on a misconfigured rate', async () => {
    // A typo must under-charge, never over-charge.
    const { service, payments } = setUp('eleven percent');

    await service.createPaymentIntent('user-1', { planCode: 'month', quantity: 1 } as any);

    expect(payments.insert.mock.calls[0][0].amount_usd).toBe(15);
  });
});

describe('SubscriptionsService.listPlans() — VAT', () => {
  function setUp(vatRate: string) {
    const plans = createMockQueryBuilder();
    plans.mockResolve([DAY_PLAN, MONTH_PLAN, YEAR_PLAN]);
    const db = createMockDb({ subscription_plans: plans });
    return new SubscriptionsService(db, registryStub, configStub(vatRate));
  }

  it('publishes NET prices with the rate alongside them', async () => {
    // The cards show the net price and say "Excluding VAT"; they need the
    // rate to know whether that sentence is true.
    const rows = await setUp('0.11').listPlans();

    expect(rows.map((r) => [r.code, r.price_usd, r.vat_rate])).toEqual([
      ['day', 5, 0.11],
      ['month', 15, 0.11],
      ['year', 100, 0.11],
    ]);
  });

  it('reports a zero rate so the cards can stay silent about VAT', async () => {
    const rows = await setUp('0').listPlans();

    expect(rows.every((r) => r.vat_rate === 0)).toBe(true);
  });
});

// ----------------------------------------------------------------
// C2 — the day pass carries message_cap 15 and the server enforces it
// exactly, but nothing told the buyer how many they had left. The first
// they knew of the cap was being refused by it.
//
// remainingMessages() already existed; it was only ever called at the
// point of refusal. getMine() is where the UI reads its plan from, so that
// is where the number has to appear.
//
// Driven through the real query path rather than by mocking
// subscription.util: that module is shared with activate() and the
// paywall, and mocking it here breaks their tests too.
// ----------------------------------------------------------------
describe('SubscriptionsService.getMine() — messages remaining', () => {
  function setup(active: Record<string, unknown> | null, messagesSent: number) {
    const subs = createMockQueryBuilder();
    // getActiveSubscription()'s .first(), then the history query's await.
    subs.first.mockResolvedValue(active ?? undefined);
    subs.mockResolve([]);

    const messages = createMockQueryBuilder();
    messages.first.mockResolvedValue({ sent: String(messagesSent) });

    const db = createMockDb({ [ACTIVE_LOOKUP]: subs, messages });
    return new SubscriptionsService(db, noVat, registryStub);
  }

  const dayPass = {
    id: 'sub-1',
    user_id: 'user-1',
    plan_code: 'day',
    status: 'active',
    message_cap: 15,
    starts_at: new Date('2026-09-16T00:00:00Z'),
    activated_at: new Date('2026-09-16T00:00:00Z'),
  };

  it('reports how many day-pass messages are left', async () => {
    const service = setup(dayPass, 4);

    const result = await service.getMine('user-1');

    expect(result.active).toMatchObject({ plan_code: 'day', messages_remaining: 11 });
  });

  it('reports zero as zero, not as absent', async () => {
    // A spent day pass and an uncapped plan must not look alike to the
    // client — one needs "0 left", the other needs no counter at all.
    const service = setup(dayPass, 15);

    const result = await service.getMine('user-1');

    expect(result.active).toMatchObject({ messages_remaining: 0 });
  });

  it('never goes negative when more were somehow sent than the cap', async () => {
    const service = setup(dayPass, 40);

    const result = await service.getMine('user-1');

    expect(result.active).toMatchObject({ messages_remaining: 0 });
  });

  it('reports null for an uncapped plan', async () => {
    const service = setup({ ...dayPass, plan_code: 'month', message_cap: null }, 900);

    const result = await service.getMine('user-1');

    expect(result.active).toMatchObject({ messages_remaining: null });
  });

  it('stays null overall when there is no active plan', async () => {
    const service = setup(null, 0);

    const result = await service.getMine('user-1');

    expect(result.active).toBeNull();
  });
});
