import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from './redis.service';

/**
 * Rate-limit counters in Redis instead of in this process's memory.
 *
 * ThrottlerModule was registered with no storage, so it used the in-process
 * memory store. The API is deployed as Vercel serverless functions, where
 * every concurrent instance keeps its own counter and instances are
 * recycled constantly — so the documented "5 registrations per minute per
 * IP" was in practice five per minute PER INSTANCE, and a new instance
 * handed the same caller a fresh budget. The limits genuinely work locally,
 * which is exactly why this hid: it is only wrong where it matters.
 *
 * Written against the existing ioredis connection rather than pulling in
 * @nest-lab/throttler-storage-redis. That package does not resolve against
 * this dependency tree (it wants a different reflect-metadata major), and
 * installing it with --legacy-peer-deps to get a forty-line class is a bad
 * trade in something that ships to production. Reusing the connection is
 * what the audit asked for either way.
 *
 * The client is read per call rather than in the constructor: RedisService
 * creates it in onModuleInit, which runs after this is instantiated by the
 * ThrottlerModule factory.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);

  constructor(private readonly redisService: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle:blocked:${throttlerName}:${key}`;

    try {
      const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] =
        (await this.redisService.getClient().eval(
          INCREMENT_SCRIPT,
          2,
          hitKey,
          blockKey,
          String(ttl),
          String(limit),
          String(blockDuration),
        )) as [number, number, number, number];

      return {
        totalHits,
        timeToExpire,
        isBlocked: isBlocked === 1,
        timeToBlockExpire,
      };
    } catch (err) {
      // Fails OPEN, and that is a decision rather than an oversight.
      //
      // The throttler sits on register, login, refresh, forgot-password,
      // reset-password, verify-email and both OTP routes. Failing closed
      // would turn a Redis blip into a total authentication outage — every
      // one of those routes 500ing — to protect limits that, until this
      // class existed, were not being enforced on serverless anyway. So
      // failing open is strictly no worse than the behaviour it replaces,
      // and it does not convert a cache outage into a site outage.
      //
      // Loud, because a limiter silently not limiting is the thing that
      // hid B5 in the first place.
      this.logger.error(
        `Redis unavailable — rate limiting is NOT being enforced for ${throttlerName}: ${
          (err as Error)?.message ?? err
        }`,
      );

      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}

/**
 * One round trip, and atomic.
 *
 * "Read the count, decide, then write the block" is a race: two instances
 * serving the same caller at the same moment both read a count under the
 * limit and both allow the request. A Lua script is evaluated by Redis as a
 * single operation, so the decision and the write cannot be interleaved —
 * which is the entire reason to move the counters out of process.
 *
 * ttl and blockDuration arrive in MILLISECONDS; timeToExpire and
 * timeToBlockExpire are returned in SECONDS, matching what
 * ThrottlerStorageService does with `Math.ceil((expiresAt - now) / 1000)`.
 * Getting that backwards produces limits that look right and expire a
 * thousand times too slowly.
 *
 * A blocked caller is not counted again, mirroring the in-memory store:
 * their hits stop accruing for the duration of the block rather than
 * extending it.
 */
const INCREMENT_SCRIPT = `
local hitKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])

local blockPttl = redis.call('PTTL', blockKey)
if blockPttl > 0 then
  local hits = tonumber(redis.call('GET', hitKey) or '0')
  local hitPttl = redis.call('PTTL', hitKey)
  if hitPttl < 0 then hitPttl = 0 end
  return { hits, math.ceil(hitPttl / 1000), 1, math.ceil(blockPttl / 1000) }
end

local totalHits = redis.call('INCR', hitKey)
if totalHits == 1 then
  redis.call('PEXPIRE', hitKey, ttl)
end

local timeToExpire = redis.call('PTTL', hitKey)
if timeToExpire < 0 then
  -- A key with no TTL would count forever. Should not happen, but a
  -- limiter that never resets is worse than one that resets early.
  redis.call('PEXPIRE', hitKey, ttl)
  timeToExpire = ttl
end

local isBlocked = 0
local timeToBlockExpire = 0
if totalHits > limit then
  redis.call('SET', blockKey, '1', 'PX', blockDuration)
  isBlocked = 1
  timeToBlockExpire = math.ceil(blockDuration / 1000)
end

return { totalHits, math.ceil(timeToExpire / 1000), isBlocked, timeToBlockExpire }
`;
