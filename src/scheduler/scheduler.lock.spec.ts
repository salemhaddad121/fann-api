import { SchedulerService, cronLockKey } from './scheduler.service';
import { createMockDb, createMockConnection } from '../test-utils/knex-mock';

/**
 * Builds a SchedulerService with everything stubbed except the pieces the
 * locking tests actually exercise. The constructor takes nine collaborators
 * and none of the others are reached on these paths.
 */
function makeService(db: any, analyticsService: any = { pruneOldEvents: jest.fn() }) {
  return new SchedulerService(
    db,
    {} as any, // bookings
    {} as any, // reviews
    {} as any, // email
    { get: jest.fn() } as any, // config
    analyticsService,
    {} as any, // subscriptions
    {} as any, // provider registry
    {} as any, // identity documents
  );
}

describe('cronLockKey()', () => {
  it('is stable, so every instance derives the same lock from the same name', () => {
    expect(cronLockKey('telemetry-prune')).toBe(cronLockKey('telemetry-prune'));
  });

  it('separates the jobs from each other', () => {
    const keys = [
      'subscription-maintenance',
      'renewal-reminders',
      'payment-reconciliation',
      'daily-review-trigger',
      'expired-review-unlock',
      'telemetry-prune',
      'identity-document-retention',
    ].map(cronLockKey);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('stays inside signed int4, which is what pg_try_advisory_lock takes', () => {
    for (const job of ['telemetry-prune', 'renewal-reminders', 'x'.repeat(200)]) {
      const key = cronLockKey(job);
      expect(Number.isInteger(key)).toBe(true);
      expect(key).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(key).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });
});

describe('SchedulerService cron locking', () => {
  it('runs the job when the lock is free', async () => {
    const analytics = { pruneOldEvents: jest.fn().mockResolvedValue(3) };
    const db = createMockDb();
    const service = makeService(db, analytics);

    await service.runTelemetryPrune();

    expect(analytics.pruneOldEvents).toHaveBeenCalled();
  });

  it('skips the job when another instance already holds the lock', async () => {
    // The whole point: two instances firing the same @Cron at the same
    // moment must not both send reminders or both promote a subscription.
    const analytics = { pruneOldEvents: jest.fn() };
    const db = createMockDb();
    db.__conn = createMockConnection(false);
    db.client.acquireConnection.mockResolvedValue(db.__conn);

    const service = makeService(db, analytics);

    await service.runTelemetryPrune();

    expect(analytics.pruneOldEvents).not.toHaveBeenCalled();
  });

  it('does not try to unlock a lock it never acquired', async () => {
    const db = createMockDb();
    db.__conn = createMockConnection(false);
    db.client.acquireConnection.mockResolvedValue(db.__conn);

    await makeService(db).runTelemetryPrune();

    const unlocks = db.__conn.query.mock.calls.filter((c: any[]) =>
      String(c[0]).includes('pg_advisory_unlock'),
    );
    expect(unlocks).toHaveLength(0);
  });

  it('releases the lock even when the job throws', async () => {
    // A session lock belongs to the connection. Stranding one would wedge
    // this job on every future run, not just the one that failed.
    const db = createMockDb();
    const service = makeService(db);

    await expect(
      (service as any).withCronLock('telemetry-prune', async () => {
        throw new Error('job blew up');
      }),
    ).resolves.toBeUndefined();

    const unlocks = db.__conn.query.mock.calls.filter((c: any[]) =>
      String(c[0]).includes('pg_advisory_unlock'),
    );
    expect(unlocks).toHaveLength(1);
  });

  it('always returns the connection to the pool', async () => {
    const db = createMockDb();
    const service = makeService(db);

    await (service as any).withCronLock('telemetry-prune', async () => {
      throw new Error('job blew up');
    });

    expect(db.client.releaseConnection).toHaveBeenCalledWith(db.__conn);
  });

  it('locks under the shared namespace so keys cannot collide with another app', async () => {
    const db = createMockDb();
    await makeService(db).runTelemetryPrune();

    const [sql, params] = db.__conn.query.mock.calls[0];
    expect(sql).toContain('pg_try_advisory_lock');
    expect(params).toEqual([0x66616e6e, cronLockKey('telemetry-prune')]);
  });

  it('skips the run rather than throwing when no connection can be had', async () => {
    const analytics = { pruneOldEvents: jest.fn() };
    const db = createMockDb();
    db.client.acquireConnection.mockRejectedValue(new Error('pool exhausted'));

    const service = makeService(db, analytics);

    await expect(service.runTelemetryPrune()).resolves.toBeUndefined();
    expect(analytics.pruneOldEvents).not.toHaveBeenCalled();
  });
});
