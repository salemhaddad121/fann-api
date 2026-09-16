import { SchedulerService, MANUAL_INTENT_ABANDON_DAYS } from './scheduler.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

/**
 * M15 — abandoned manual payment intents never aged out of the admin queue.
 *
 * doPaymentReconciliation() excludes provider='manual' from the
 * intent_expires_at sweep on purpose, and that exclusion is correct: a
 * human confirms those and it can take hours. But manual is the only live
 * provider, so nothing else expired them either. A 180-day-old intent was
 * still 'awaiting_provider' after a full run, and every buyer who opened
 * the payment screen and walked away left a row in a queue somebody works
 * daily.
 *
 * The fix is a separate, much slower ageing rule — not a removal of the
 * exclusion.
 */
function makeService(db: any) {
  return new SchedulerService(
    db,
    {} as any, // bookings
    {} as any, // reviews
    {} as any, // email
    { get: jest.fn() } as any, // config
    { pruneOldEvents: jest.fn() } as any,
    {} as any, // subscriptions
    { pollable: () => [] } as any,
    {} as any, // identity documents
  );
}

/**
 * Records every builder the job creates against `payments`, since the job
 * runs two separate updates over that table in one pass.
 */
function paymentsSpy() {
  const builders: any[] = [];
  const factory = () => {
    const qb = createMockQueryBuilder();
    qb.returning.mockResolvedValue([]);
    builders.push(qb);
    return qb;
  };
  return { builders, factory };
}

function conditionsOn(builder: any) {
  return JSON.stringify([
    builder.where.mock.calls,
    builder.whereNot.mock.calls,
    builder.whereNull.mock.calls,
    builder.whereNotNull.mock.calls,
    builder.whereRaw.mock.calls,
  ]);
}

describe('SchedulerService — manual intent ageing', () => {
  function run() {
    const { builders, factory } = paymentsSpy();
    const db: any = createMockDb();
    const base = db;
    const wrapped: any = jest.fn((table: string) =>
      table === 'payments' ? factory() : base(table),
    );
    Object.assign(wrapped, base);
    const service = makeService(wrapped);
    return { service, builders };
  }

  it('expires manual intents that are old AND have no transfer reported', async () => {
    const { service, builders } = run();

    await (service as any).doPaymentReconciliation();

    const manual = builders.find((b) =>
      b.where.mock.calls.some(([col, val]: any[]) => col === 'provider' && val === 'manual'),
    );
    expect(manual).toBeDefined();

    const conditions = conditionsOn(manual);
    // reference_code is set by the "I've sent the payment" step. A row that
    // has one is a buyer waiting on US, and expiring it would be us
    // cancelling on them.
    expect(conditions).toContain('reference_code');
    expect(conditions).toContain(`${MANUAL_INTENT_ABANDON_DAYS} days`);
    expect(manual.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expired' }),
    );
  });

  it('leaves the human-confirmation path alone', async () => {
    // The intent_expires_at sweep must still exclude manual entirely —
    // M15 is an extra rule, not a removal of that exclusion.
    const { service, builders } = run();

    await (service as any).doPaymentReconciliation();

    const sweep = builders.find((b) =>
      b.whereNot.mock.calls.some(
        ([col, val]: any[]) => col === 'provider' && val === 'manual',
      ),
    );
    expect(sweep).toBeDefined();
    expect(conditionsOn(sweep)).toContain('intent_expires_at');
  });

  it('ages manual intents far more slowly than automated ones', async () => {
    // 30 days versus the 15-minute cron. Expiring a real transfer early
    // and leaving a stale row late are not symmetric costs.
    expect(MANUAL_INTENT_ABANDON_DAYS).toBeGreaterThanOrEqual(30);
  });
});
