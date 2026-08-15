import { Injectable } from '@nestjs/common';
import {
  CreateIntentInput,
  PaymentIntent,
  ParsedWebhook,
  PaymentProvider,
} from './payment-provider.interface';

/**
 * The current flow: the buyer transfers money and an admin confirms it.
 *
 * Keep this permanently, even once a real provider is live. It is the
 * fallback when a gateway is down, when a buyer has no card, and when a
 * transfer arrives that automation could not match — all of which happen.
 *
 * There is no webhook: nothing calls back, because the confirmation is a
 * person clicking a button in the admin panel. verifySignature therefore
 * refuses everything rather than returning true, so that a webhook posted
 * to /webhooks/payments/manual — whether by mistake or on purpose — cannot
 * mint a subscription that nobody approved.
 */
@Injectable()
export class ManualProvider implements PaymentProvider {
  readonly code = 'manual';

  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    return {
      // No external system issued anything, so the reference is our own
      // payment id. It still has to be unique per provider, and it is.
      providerRef: input.paymentId,
      instructions: [
        `Transfer $${input.amountUsd.toFixed(2)} ${input.currency}.`,
        `Quote reference ${input.accountCode} on the transfer.`,
        'Then tell us the transfer reference number so we can match it.',
      ].join(' '),
    };
  }

  verifySignature(): boolean {
    // Not "no signature to check" — actively refuse. This provider is
    // confirmed by a human, so any inbound webhook claiming to be it is
    // either a mistake or an attempt to skip that step.
    return false;
  }

  parseWebhook(): ParsedWebhook {
    throw new Error('The manual provider does not receive webhooks.');
  }
}
