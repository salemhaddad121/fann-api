import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import {
  CreateIntentInput,
  PaymentIntent,
  ParsedWebhook,
  PaymentProvider,
} from './payment-provider.interface';

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

/**
 * A fake provider that behaves like a real one.
 *
 * This is the point of the whole wave. It lets the entire automated path —
 * intent, redirect, webhook, signature check, idempotent match, status
 * transition, subscription minted, notification sent, admin sees it — be
 * built and tested to completion today, with no merchant account and no
 * credentials. When real credentials arrive, the only untested surface is
 * the adapter itself.
 *
 * The signature is a real HMAC-SHA256 over the raw body, compared in
 * constant time, exactly as a real provider's would be. A mock that
 * skipped verification would leave the riskiest part of the integration
 * unexercised, which is precisely the part that is hard to debug later.
 */
@Injectable()
export class MockProvider implements PaymentProvider {
  readonly code = 'mock';

  constructor(private readonly configService: ConfigService) {}

  private get secret(): string {
    // Dev-only default. A real provider's secret would have no fallback.
    return this.configService.get<string>('MOCK_PAYMENT_SECRET') ?? 'mock-secret';
  }

  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    const providerRef = `mock_${randomUUID()}`;
    const appUrl = this.configService.get<string>('APP_URL') ?? 'http://localhost:4000';

    return {
      providerRef,
      // Points at the stub checkout below, so the frontend's redirect
      // branch is exercised rather than assumed.
      redirectUrl: `${appUrl}/api/v1/payments/mock/checkout/${providerRef}`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
  }

  /** Signs a body the way the provider would. Used by the stub endpoint. */
  sign(rawBody: Buffer | string): string {
    return createHmac('sha256', this.secret)
      .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody))
      .digest('hex');
  }

  verifySignature(rawBody: Buffer, headers: Record<string, string>): boolean {
    const provided = headers[MOCK_SIGNATURE_HEADER];
    if (!provided) return false;

    const expected = this.sign(rawBody);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);

    // Length check first: timingSafeEqual throws on a length mismatch, and
    // comparing in constant time is the whole point of using it.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: Buffer): ParsedWebhook {
    const payload = JSON.parse(rawBody.toString('utf8'));

    return {
      providerRef: payload.reference,
      status: payload.status ?? 'unknown',
      amount: Number(payload.amount),
      currency: payload.currency ?? 'USD',
      eventType: payload.event,
    };
  }

  /**
   * Polling support, so the reconciliation job has something to exercise.
   *
   * Always reports 'unknown' — a mock cannot know what a real provider
   * would say, and returning 'paid' here would let the reconciler mint
   * subscriptions for intents nobody paid.
   */
  async getStatus(): Promise<ParsedWebhook['status']> {
    return 'unknown';
  }
}
