import { WebhooksService } from './webhooks.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

const SIGNED = { 'x-mock-signature': 'valid' };

function makeProvider(overrides: Record<string, unknown> = {}) {
  return {
    code: 'mock',
    verifySignature: jest.fn(() => true),
    parseWebhook: jest.fn(() => ({
      providerRef: 'mock_ref',
      status: 'paid',
      amount: 15,
      currency: 'USD',
      eventType: 'payment.completed',
    })),
    ...overrides,
  };
}

function makeRegistry(provider: ReturnType<typeof makeProvider>) {
  return {
    has: jest.fn(() => true),
    byCode: jest.fn(() => provider),
  } as any;
}

function makeSetup(payment: Record<string, unknown> | undefined) {
  const events = createMockQueryBuilder();
  events.returning.mockResolvedValue([{ id: 'event-1' }]);

  const payments = createMockQueryBuilder();
  payments.first.mockResolvedValue(payment);

  const notifications = createMockQueryBuilder();
  const users = createMockQueryBuilder();
  users.mockResolve([{ id: 'admin-1' }]);

  const db = createMockDb({
    payment_webhook_events: events,
    payments,
    notifications,
    users,
  });

  return { db, events, payments, notifications };
}

const confirmedPayment = {
  id: 'pay-1',
  planner_id: 'user-1',
  amount_usd: '15.00',
  currency: 'USD',
  status: 'awaiting_provider',
  plan_code: 'month',
  quantity: 1,
};

describe('WebhooksService.process()', () => {
  it('records the event before doing anything else', async () => {
    // An event we refused is far more useful to debug than one we dropped,
    // and this is the only record of an integration that cannot be
    // reproduced locally.
    const provider = makeProvider({ verifySignature: jest.fn(() => false) });
    const { db, events } = makeSetup(undefined);
    const mint = jest.fn();

    await new WebhooksService(db, makeRegistry(provider), { mintForPayment: mint } as any).process(
      'mock',
      Buffer.from('{}'),
      SIGNED,
    );

    expect(events.insert).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'mock', signature_ok: false }),
    );
  });

  it('rejects a bad signature without minting', async () => {
    const provider = makeProvider({ verifySignature: jest.fn(() => false) });
    const { db } = makeSetup(confirmedPayment);
    const mint = jest.fn();

    const outcome = await new WebhooksService(
      db,
      makeRegistry(provider),
      { mintForPayment: mint } as any,
    ).process('mock', Buffer.from('{}'), SIGNED);

    expect(outcome).toBe('bad_signature');
    expect(mint).not.toHaveBeenCalled();
  });

  it('is a no-op when the payment is already confirmed', async () => {
    // The replay guard. Providers retry, and a retry must not hand out a
    // second subscription for one payment.
    const provider = makeProvider();
    const { db } = makeSetup({ ...confirmedPayment, status: 'confirmed' });
    const mint = jest.fn();

    const outcome = await new WebhooksService(
      db,
      makeRegistry(provider),
      { mintForPayment: mint } as any,
    ).process('mock', Buffer.from('{}'), SIGNED);

    expect(outcome).toBe('already_confirmed');
    expect(mint).not.toHaveBeenCalled();
  });

  it('marks a mismatched amount as disputed and mints nothing', async () => {
    // Without this, a webhook claiming $5 could confirm a $100 purchase.
    const provider = makeProvider({
      parseWebhook: jest.fn(() => ({
        providerRef: 'mock_ref',
        status: 'paid',
        amount: 5,
        currency: 'USD',
      })),
    });
    const { db, payments } = makeSetup(confirmedPayment);
    const mint = jest.fn();

    const outcome = await new WebhooksService(
      db,
      makeRegistry(provider),
      { mintForPayment: mint } as any,
    ).process('mock', Buffer.from('{}'), SIGNED);

    expect(outcome).toBe('amount_mismatch');
    expect(mint).not.toHaveBeenCalled();
    expect(payments.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'disputed' }),
    );
  });

  it('rejects a mismatched currency even when the number matches', async () => {
    // 15 USD and 15 LBP are not the same payment.
    const provider = makeProvider({
      parseWebhook: jest.fn(() => ({
        providerRef: 'mock_ref',
        status: 'paid',
        amount: 15,
        currency: 'LBP',
      })),
    });
    const { db } = makeSetup(confirmedPayment);
    const mint = jest.fn();

    const outcome = await new WebhooksService(
      db,
      makeRegistry(provider),
      { mintForPayment: mint } as any,
    ).process('mock', Buffer.from('{}'), SIGNED);

    expect(outcome).toBe('amount_mismatch');
    expect(mint).not.toHaveBeenCalled();
  });

  it('records and stops when no payment matches the reference', async () => {
    // Out-of-order delivery: a confirmation arriving before the intent row
    // is visible must be recorded, not crash, and not invent a payment.
    const provider = makeProvider();
    const { db } = makeSetup(undefined);
    const mint = jest.fn();

    const outcome = await new WebhooksService(
      db,
      makeRegistry(provider),
      { mintForPayment: mint } as any,
    ).process('mock', Buffer.from('{}'), SIGNED);

    expect(outcome).toBe('payment_not_found');
    expect(mint).not.toHaveBeenCalled();
  });

  it('confirms and mints when everything checks out', async () => {
    const provider = makeProvider();
    const { db, notifications } = makeSetup(confirmedPayment);
    const mint = jest.fn().mockResolvedValue({ minted: 1 });

    const outcome = await new WebhooksService(
      db,
      makeRegistry(provider),
      { mintForPayment: mint } as any,
    ).process('mock', Buffer.from('{}'), SIGNED);

    expect(outcome).toBe('confirmed');
    // Minting goes through the same method the admin confirm button calls.
    expect(mint).toHaveBeenCalledWith('pay-1', expect.anything());
    expect(notifications.insert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment_confirmed' }),
    );
  });

  it('marks a failed payment rejected rather than minting', async () => {
    const provider = makeProvider({
      parseWebhook: jest.fn(() => ({
        providerRef: 'mock_ref',
        status: 'failed',
        amount: 15,
        currency: 'USD',
      })),
    });
    const { db, payments } = makeSetup(confirmedPayment);
    const mint = jest.fn();

    const outcome = await new WebhooksService(
      db,
      makeRegistry(provider),
      { mintForPayment: mint } as any,
    ).process('mock', Buffer.from('{}'), SIGNED);

    expect(outcome).toBe('not_paid');
    expect(mint).not.toHaveBeenCalled();
    expect(payments.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected' }),
    );
  });

  it('records an unknown provider without throwing', async () => {
    const registry = { has: jest.fn(() => false), byCode: jest.fn() } as any;
    const { db, events } = makeSetup(undefined);

    const outcome = await new WebhooksService(db, registry, { mintForPayment: jest.fn() } as any).process(
      'not-a-provider',
      Buffer.from('{}'),
      SIGNED,
    );

    expect(outcome).toBe('recorded_unknown_provider');
    expect(events.insert).toHaveBeenCalled();
  });
});
