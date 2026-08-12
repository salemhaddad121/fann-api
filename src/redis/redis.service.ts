import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { classifyRedisError } from './redis-error';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;
  private readonly logger = new Logger(RedisService.name);

  // Connection history, used to tell an idle reconnect apart from an
  // outage — see redis-error.ts.
  private hasConnected = false;
  private consecutiveErrors = 0;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    // REDIS_URL wins when present. Hosted Redis (Upstash, Redis Cloud) hands
    // out a single rediss:// string, and crucially requires TLS — the
    // discrete host/port/password form below has no TLS and silently fails
    // to connect against them.
    //
    // The local Docker Redis has no TLS and no URL, so it keeps using the
    // discrete variables and is unaffected.
    const url = this.configService.get<string>('REDIS_URL');

    if (url) {
      this.client = new Redis(url, {
        // Serverless dials on cold start; failing fast and retrying beats a
        // request hanging on a connection that will not come up.
        maxRetriesPerRequest: 3,
        // ioredis infers TLS from the rediss:// scheme, but hosts that
        // publish a redis:// URL while still requiring TLS are common
        // enough to be worth the explicit escape hatch.
        ...(this.configService.get<string>('REDIS_TLS') === 'true' ? { tls: {} } : {}),
      });
      this.attachDiagnostics();
      return;
    }

    this.client = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD'),
      ...(this.configService.get<string>('REDIS_TLS') === 'true' ? { tls: {} } : {}),
    });
    this.attachDiagnostics();
  }

  /**
   * Without an 'error' listener ioredis prints "Unhandled error event" for
   * every dropped connection, which on serverless is constant background
   * noise — and noise is what hides a real failure. This attaches one and
   * grades what it receives.
   *
   * Note this only changes reporting. ioredis reconnects on its own either
   * way; commands already fail through maxRetriesPerRequest.
   */
  private attachDiagnostics() {
    this.client.on('ready', () => {
      if (this.consecutiveErrors > 0) {
        // Worth saying out loud: it closes off an incident that may have
        // been reported at error level a moment earlier.
        this.logger.log(
          `Redis connection restored after ${this.consecutiveErrors} consecutive error(s).`,
        );
      }
      this.hasConnected = true;
      this.consecutiveErrors = 0;
    });

    this.client.on('error', (error: unknown) => {
      this.consecutiveErrors += 1;
      const { level, reason } = classifyRedisError(error, {
        hasConnected: this.hasConnected,
        consecutiveErrors: this.consecutiveErrors,
      });

      const message =
        `Redis error [${reason}] after ${this.consecutiveErrors} consecutive ` +
        `failure(s): ${error instanceof Error ? error.message : String(error)}`;

      // The stack is only useful on the ones worth acting on.
      if (level === 'error') {
        this.logger.error(message, error instanceof Error ? error.stack : undefined);
      } else if (level === 'warn') {
        this.logger.warn(message);
      } else {
        this.logger.debug(message);
      }
    });
  }

  onModuleDestroy() {
    this.client.quit();
  }

  // ----------------------------------------------------------------
  // OTP — 6-digit code, keyed by phone number, TTL 10 minutes
  // ----------------------------------------------------------------
  private otpKey(phone: string) {
    return `otp:${phone}`;
  }

  async setOtp(phone: string, code: string): Promise<void> {
    await this.client.set(this.otpKey(phone), code, 'EX', 600); // 10 min
  }

  async getOtp(phone: string): Promise<string | null> {
    return this.client.get(this.otpKey(phone));
  }

  async deleteOtp(phone: string): Promise<void> {
    await this.client.del(this.otpKey(phone));
  }

  // ----------------------------------------------------------------
  // Refresh tokens — keyed by userId, TTL 30 days
  // Storing the token hash so we can invalidate on logout.
  // ----------------------------------------------------------------
  private refreshKey(userId: string) {
    return `refresh:${userId}`;
  }

  async setRefreshToken(userId: string, tokenHash: string): Promise<void> {
    await this.client.set(this.refreshKey(userId), tokenHash, 'EX', 60 * 60 * 24 * 30);
  }

  async getRefreshToken(userId: string): Promise<string | null> {
    return this.client.get(this.refreshKey(userId));
  }

  async deleteRefreshToken(userId: string): Promise<void> {
    await this.client.del(this.refreshKey(userId));
  }

  // ----------------------------------------------------------------
  // Email verification tokens — TTL 24 hours
  // ----------------------------------------------------------------
  private emailVerifyKey(token: string) {
    return `email-verify:${token}`;
  }

  async setEmailVerifyToken(token: string, userId: string): Promise<void> {
    await this.client.set(this.emailVerifyKey(token), userId, 'EX', 60 * 60 * 24);
  }

  async getEmailVerifyToken(token: string): Promise<string | null> {
    return this.client.get(this.emailVerifyKey(token));
  }

  async deleteEmailVerifyToken(token: string): Promise<void> {
    await this.client.del(this.emailVerifyKey(token));
  }

  // ----------------------------------------------------------------
  // Password reset tokens — TTL 1 hour (shorter than email verify;
  // this grants account takeover if leaked, so keep the window tight)
  // ----------------------------------------------------------------
  private passwordResetKey(token: string) {
    return `password-reset:${token}`;
  }

  async setPasswordResetToken(token: string, userId: string): Promise<void> {
    await this.client.set(this.passwordResetKey(token), userId, 'EX', 60 * 60);
  }

  async getPasswordResetToken(token: string): Promise<string | null> {
    return this.client.get(this.passwordResetKey(token));
  }

  async deletePasswordResetToken(token: string): Promise<void> {
    await this.client.del(this.passwordResetKey(token));
  }
}
