import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ParsedWebhook } from './providers/payment-provider.interface';

/** What happened, for logging and tests. Never sent to the provider. */
export type WebhookOutcome =
  | 'recorded_unknown_provider'
  | 'bad_signature'
  | 'unparseable'
  | 'payment_not_found'
  | 'amount_mismatch'
  | 'already_confirmed'
  | 'not_paid'
  | 'confirmed';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectConnection() private readonly db: Knex,
    private readonly registry: PaymentProviderRegistry,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /**
   * Processes one inbound webhook.
   *
   * The ORDER here is the whole design, and each step exists because of a
   * specific way payment integrations go wrong:
   *
   *  1. Record the event before any validation. An event we refused is far
   *     more useful to debug than one we dropped, and this is the only
   *     record of an integration that cannot be reproduced locally.
   *  2. Verify the signature over the RAW bytes.
   *  3. Match the payment by (provider, provider_ref) — the idempotency key.
   *  4. Compare amount and currency against the stored intent. This is the
   *     guard against a tampered or misrouted callback: without it, a
   *     webhook claiming $5 could confirm a $100 purchase.
   *  5. Already confirmed is a no-op. Providers retry, and a retry must
   *     not mint a second subscription.
   *  6. Only then transition and mint, through the same function the admin
   *     confirm button calls.
   *
   * Always resolves. The caller answers 200 regardless — see the
   * controller for why.
   */
  async process(
    providerCode: string,
    rawBody: Buffer,
    headers: Record<string, string>,
  ): Promise<WebhookOutcome> {
    // ── 1. Record first, always ──
    const [event] = await this.db('payment_webhook_events')
      .insert({
        provider: providerCode,
        signature_ok: false, // updated below once known
        raw_body: rawBody.toString('utf8'),
        headers: JSON.stringify(headers),
      })
      .returning(['id']);

    const finish = async (outcome: WebhookOutcome, error?: string) => {
      await this.db('payment_webhook_events')
        .where({ id: event.id })
        .update({ processed_at: this.db.fn.now(), process_error: error ?? null });
      return outcome;
    };

    if (!this.registry.has(providerCode)) {
      this.logger.warn(`[Webhooks] Unknown provider "${providerCode}"`);
      return finish('recorded_unknown_provider', `unknown provider: ${providerCode}`);
    }

    const provider = this.registry.byCode(providerCode);

    // ── 2. Signature ──
    if (!provider.verifySignature(rawBody, headers)) {
      this.logger.warn(`[Webhooks] Bad signature from "${providerCode}"`);
      return finish('bad_signature', 'signature verification failed');
    }

    await this.db('payment_webhook_events')
      .where({ id: event.id })
      .update({ signature_ok: true });

    let parsed: ParsedWebhook;
    try {
      parsed = provider.parseWebhook(rawBody);
    } catch (err) {
      return finish('unparseable', String(err));
    }

    await this.db('payment_webhook_events').where({ id: event.id }).update({
      provider_ref: parsed.providerRef,
      event_type: parsed.eventType ?? null,
    });

    // ── 3. Match the payment ──
    const payment = await this.db('payments')
      .where({ provider: providerCode, provider_ref: parsed.providerRef })
      .first();

    if (!payment) {
      this.logger.warn(
        `[Webhooks] No payment for ${providerCode}/${parsed.providerRef}`,
      );
      return finish('payment_not_found', 'no matching payment');
    }

    await this.db('payment_webhook_events')
      .where({ id: event.id })
      .update({ payment_id: payment.id });

    // ── 5. Replay guard, before any state change ──
    if (payment.status === 'confirmed') {
      this.logger.log(`[Webhooks] Payment ${payment.id} already confirmed — no-op.`);
      return finish('already_confirmed');
    }

    // ── 4. Amount and currency must match what we issued ──
    const expected = Number(payment.amount_usd);
    const received = Number(parsed.amount);
    const amountMatches = Number.isFinite(received) && Math.abs(expected - received) < 0.01;
    const currencyMatches =
      (parsed.currency ?? '').toUpperCase() === (payment.currency ?? 'USD').toUpperCase();

    if (!amountMatches || !currencyMatches) {
      this.logger.error(
        `[Webhooks] Amount mismatch on ${payment.id}: expected ${expected} ${payment.currency}, got ${received} ${parsed.currency}`,
      );
      await this.db('payments').where({ id: payment.id }).update({
        status: 'disputed',
        updated_at: this.db.fn.now(),
      });
      await this.notifyAdminsOfDispute(payment.id, expected, received);
      return finish(
        'amount_mismatch',
        `expected ${expected} ${payment.currency}, got ${received} ${parsed.currency}`,
      );
    }

    if (parsed.status !== 'paid') {
      await this.db('payments')
        .where({ id: payment.id })
        .update({
          status: parsed.status === 'failed' ? 'rejected' : 'expired',
          updated_at: this.db.fn.now(),
        });
      return finish('not_paid', `provider reported ${parsed.status}`);
    }

    // ── 6. Confirm and mint, in one transaction ──
    await this.db.transaction(async (trx) => {
      await trx('payments').where({ id: payment.id }).update({
        status: 'confirmed',
        confirmed_at: this.db.fn.now(),
        provider_payload: JSON.stringify(parsed),
        updated_at: this.db.fn.now(),
      });

      // The same method the admin confirm button calls. One implementation
      // of the stacking rules, two callers.
      await this.subscriptions.mintForPayment(payment.id, trx);
    });

    await this.db('notifications').insert({
      user_id: payment.planner_id,
      type: 'payment_confirmed',
      title: 'Your payment was confirmed',
      data: JSON.stringify({
        payment_id: payment.id,
        plan_code: payment.plan_code,
        quantity: payment.quantity,
      }),
    });

    this.logger.log(`[Webhooks] Confirmed payment ${payment.id} via ${providerCode}`);
    return finish('confirmed');
  }

  /**
   * A mismatch means someone was charged an amount we did not ask for, or
   * a callback was aimed at the wrong payment. Both need a human, and
   * neither should mint anything.
   */
  private async notifyAdminsOfDispute(
    paymentId: string,
    expected: number,
    received: number,
  ): Promise<void> {
    try {
      const admins = await this.db('users').where({ role: 'admin' }).select('id');
      if (admins.length === 0) return;

      await this.db('notifications').insert(
        admins.map((admin) => ({
          user_id: admin.id,
          type: 'payment_disputed',
          title: 'A payment amount did not match',
          data: JSON.stringify({ payment_id: paymentId, expected, received }),
        })),
      );
    } catch (err) {
      this.logger.error('[Webhooks] Failed to notify admins of dispute', err);
    }
  }
}
