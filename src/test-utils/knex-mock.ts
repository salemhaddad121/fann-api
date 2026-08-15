/**
 * A lightweight Knex mock for unit tests.
 *
 * Real Knex query builders are chainable (`.where().whereIn().first()`),
 * so every non-terminal method here just returns the same mock object.
 * Terminal methods (`first`, `returning`, `delete`, etc.) are plain
 * jest.fn()s you configure per test with `.mockResolvedValueOnce(...)`.
 *
 * Usage:
 *   const bookingsBuilder = createMockQueryBuilder();
 *   bookingsBuilder.first.mockResolvedValueOnce({ id: '1', status: 'pending' });
 *   bookingsBuilder.returning.mockResolvedValueOnce([{ id: '1', status: 'accepted' }]);
 *   const db = createMockDb({ bookings: bookingsBuilder });
 */

const CHAIN_METHODS = [
  "where",
  "whereIn",
  "whereNot",
  "whereNull",
  "whereNotNull",
  "whereILike",
  "whereRaw",
  "whereExists",
  "whereNotExists",
  "orderBy",
  "groupBy",
  "select",
  "join",
  "leftJoin",
  "limit",
  "offset",
  "clone",
  "clearSelect",
  "clearOrder",
];

export function createMockQueryBuilder() {
  const qb: Record<string, any> = {};
  for (const method of CHAIN_METHODS) {
    qb[method] = jest.fn(() => qb);
  }
  qb.first = jest.fn();
  qb.update = jest.fn(() => qb);
  qb.returning = jest.fn();
  qb.insert = jest.fn(() => qb);
  qb.delete = jest.fn();
  // Knex exposes both spellings and the codebase uses `.del()` (see
  // AnalyticsService.pruneOldEvents). Same jest.fn() behind both, so a test
  // can stub either name and the other still reflects the call.
  qb.del = qb.delete;
  qb.count = jest.fn(() => qb);
  qb.max = jest.fn(() => qb);
  qb.onConflict = jest.fn(() => qb);
  // Upsert: .onConflict(...).merge(...) — chainable, so the terminal
  // .returning()/.then() after it still resolves.
  qb.merge = jest.fn(() => qb);
  qb.ignore = jest.fn();

  // Real Knex query builders are "thenable" — you can `await` the chain
  // at any point, not just after a terminal like .first(). Several
  // services rely on this (e.g. `await db('reviews').where(...).select(...)`
  // with no .first()/.returning() at the end), so this mock supports it
  // too: `qb.select(...)` (and any other chain call) stays chainable, but
  // `await qb` resolves to whatever `mockResolve()` was set to (default []).
  qb.__resolved = [];
  qb.mockResolve = (value: any) => {
    qb.__resolved = value;
    return qb;
  };
  qb.then = (onFulfilled?: any, onRejected?: any) =>
    Promise.resolve(qb.__resolved).then(onFulfilled, onRejected);
  qb.catch = (onRejected?: any) => Promise.resolve(qb.__resolved).catch(onRejected);

  return qb as any;
}

export function createMockDb(tableBuilders: Record<string, any> = {}) {
  const db: any = jest.fn((table: string) => tableBuilders[table] ?? createMockQueryBuilder());
  db.fn = { now: jest.fn(() => "NOW()") };
  db.raw = jest.fn((sql: string) => sql);
  // Column reference used inside correlated subqueries, e.g.
  // `.where('ac.artist_profile_id', db.ref('ap.id'))` in ArtistsService.search.
  db.ref = jest.fn((column: string) => column);
  db.transaction = jest.fn(async (cb: (trx: any) => Promise<any>) => cb(db));

  // Knex's connection pool, used by SchedulerService.withCronLock() to hold
  // one connection for the life of a session-scoped advisory lock. Defaults
  // to granting the lock, so a test that does not care about locking gets
  // the job running without setting anything up; pass `false` to
  // createMockConnection() to simulate another instance holding it.
  db.__conn = createMockConnection(true);
  db.client = {
    acquireConnection: jest.fn(async () => db.__conn),
    releaseConnection: jest.fn(async () => undefined),
  };

  return db;
}

/**
 * A pg connection that answers pg_try_advisory_lock with `acquired`.
 *
 * Attach with `db.__conn = createMockConnection(false)` and
 * `db.client.acquireConnection.mockResolvedValue(db.__conn)` to test the
 * path where a second instance is already running the job.
 */
export function createMockConnection(acquired = true) {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired }] };
      return { rows: [] };
    }),
  };
}
