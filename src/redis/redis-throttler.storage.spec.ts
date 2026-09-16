import { RedisThrottlerStorage } from './redis-throttler.storage';

// A tiny in-memory stand-in for the Lua script's semantics is not what is
// wanted here — that would test a reimplementation. These run the real
// script against the real ioredis client when one is reachable, and are
// skipped with a visible reason when it is not.
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// These exercise the real Lua script against a real Redis, because a
// hand-rolled stand-in would only test a reimplementation of the thing
// being verified. docker-compose ships a Redis and the dev environment runs
// one, so the default is to RUN them and fail loudly if it is missing — a
// silent skip is how a rate limiter that is not limiting stays hidden, and
// that is the bug this class exists to fix.
//
// SKIP_REDIS_TESTS=1 opts out explicitly, for an environment that genuinely
// has no Redis.
const describeRedis = process.env.SKIP_REDIS_TESTS === '1' ? describe.skip : describe;

describeRedis('RedisThrottlerStorage (against a real Redis)', () => {
  let client: Redis;
  let storage: RedisThrottlerStorage;

  beforeAll(async () => {
    client = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    try {
      await client.connect();
      await client.ping();
    } catch (err) {
      throw new Error(
        `Redis at ${REDIS_URL} is unreachable (${(err as Error).message}). ` +
        'Start it with `docker compose up -d redis`, or set SKIP_REDIS_TESTS=1 ' +
        'to skip these — but then say so, because they will not have run.',
        { cause: err },
      );
    }
    storage = new RedisThrottlerStorage({ getClient: () => client } as never);
  });

  afterAll(async () => {
    const keys = await client.keys('throttle:*:spec-*');
    if (keys.length) await client.del(...keys);
    client.disconnect();
  });

  // Unique per run so a re-run never inherits a previous run's counters.
  const keyFor = (name: string) => `spec-${name}-${Date.now()}-${Math.random()}`;

  it('counts hits and reports them in seconds, not milliseconds', async () => {
    // ttl arrives in ms; timeToExpire goes back in seconds. Getting that
    // backwards produces limits that look right and expire 1000x too slowly.
    const key = keyFor('counts');

    const first = await storage.increment(key, 60000, 5, 60000, 'default');
    const second = await storage.increment(key, 60000, 5, 60000, 'default');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(first.timeToExpire).toBeLessThanOrEqual(60);
    expect(first.timeToExpire).toBeGreaterThan(0);
    expect(first.isBlocked).toBe(false);
  });

  it('blocks once the limit is exceeded', async () => {
    const key = keyFor('blocks');

    for (let i = 0; i < 3; i++) {
      const record = await storage.increment(key, 60000, 3, 60000, 'default');
      expect(record.isBlocked).toBe(false);
    }

    const fourth = await storage.increment(key, 60000, 3, 60000, 'default');
    expect(fourth.isBlocked).toBe(true);
    expect(fourth.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('stops counting a caller who is already blocked', async () => {
    // Mirrors the in-memory store: hits do not accrue during a block, so
    // the block is not silently extended by further attempts.
    const key = keyFor('frozen');

    for (let i = 0; i < 3; i++) await storage.increment(key, 60000, 2, 60000, 'default');
    const before = await storage.increment(key, 60000, 2, 60000, 'default');
    const after = await storage.increment(key, 60000, 2, 60000, 'default');

    expect(before.isBlocked).toBe(true);
    expect(after.totalHits).toBe(before.totalHits);
  });

  it('keeps separate counters per throttler name', async () => {
    const key = keyFor('named');

    await storage.increment(key, 60000, 5, 60000, 'default');
    const other = await storage.increment(key, 60000, 5, 60000, 'strict');

    expect(other.totalHits).toBe(1);
  });

  // The behaviour that makes B5 a fix rather than a rename: the counter
  // outlives the process, so a recycled Vercel instance does not hand the
  // same caller a fresh budget.
  it('survives a new storage instance, as a new function instance would', async () => {
    const key = keyFor('survives');

    await storage.increment(key, 60000, 5, 60000, 'default');
    await storage.increment(key, 60000, 5, 60000, 'default');

    const restarted = new RedisThrottlerStorage({ getClient: () => client } as never);
    const third = await restarted.increment(key, 60000, 5, 60000, 'default');

    expect(third.totalHits).toBe(3);
  });


});

// No Redis needed — these are about what happens when there isn't one.
describe('RedisThrottlerStorage when Redis is unavailable', () => {
  const brokenStorage = () => {
    const storage = new RedisThrottlerStorage({
      getClient: () => ({ eval: () => Promise.reject(new Error('ECONNREFUSED')) }),
    } as never);
    const logger = jest
      .spyOn((storage as any).logger, 'error')
      .mockImplementation(() => undefined);
    return { storage, logger };
  };

  it('fails open rather than 500ing every auth route', async () => {
    // The throttler sits on login, register, refresh, both password routes
    // and both OTP routes. Failing closed would turn a cache blip into a
    // total authentication outage — to protect limits that, before this
    // class existed, were not enforced on serverless anyway.
    const { storage } = brokenStorage();

    const record = await storage.increment('spec-down', 60000, 5, 60000, 'default');

    expect(record.isBlocked).toBe(false);
    expect(record.totalHits).toBe(0);
    expect(record.timeToExpire).toBe(60);
  });

  it('says loudly that it is not enforcing', async () => {
    const { storage, logger } = brokenStorage();

    await storage.increment('spec-down', 60000, 5, 60000, 'default');

    expect(logger).toHaveBeenCalledWith(expect.stringContaining('NOT being enforced'));
  });
});
