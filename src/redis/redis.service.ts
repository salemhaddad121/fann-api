import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    this.client = new Redis({
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD'),
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
