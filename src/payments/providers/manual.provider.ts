import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateIntentInput,
  PaymentIntent,
  PaymentRecipient,
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
  private readonly logger = new Logger(ManualProvider.name);

  constructor(private readonly configService: ConfigService) {}

  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    const recipient = this.recipient();

    return {
      // No external system issued anything, so the reference is our own
      // payment id. It still has to be unique per provider, and it is.
      providerRef: input.paymentId,
      instructions: [
        `Transfer $${input.amountUsd.toFixed(2)} ${input.currency}.`,
        `Quote reference ${input.accountCode} on the transfer.`,
        'Then tell us the transfer reference number so we can match it.',
      ].join(' '),
      recipient,
    };
  }

  /**
   * Where the money goes.
   *
   * Environment variables rather than literals so the account can change
   * without a deploy — a payment detail that needs a code review and a
   * build to correct is a payment detail that stays wrong for a day.
   *
   * Returns undefined rather than a half-filled object when the account is
   * not configured. A recipient block showing "Whish Money" above two blank
   * lines is worse than no block: it looks like the page failed rather than
   * like the shop is not open, and the buyer transfers nothing either way.
   * Logged at error level because a live payment screen with no payee is an
   * outage, not a warning.
   */
  private recipient(): PaymentRecipient | undefined {
    const accountName = this.configService.get<string>('WHISH_ACCOUNT_NAME')?.trim();
    const accountNumber = this.configService.get<string>('WHISH_ACCOUNT_NUMBER')?.trim();

    if (!accountName || !accountNumber) {
      this.logger.error(
        'WHISH_ACCOUNT_NAME / WHISH_ACCOUNT_NUMBER are not set — the payment ' +
        'screen cannot tell buyers where to send the money, and nobody can ' +
        'complete a purchase.',
      );
      return undefined;
    }

    return {
      service: this.configService.get<string>('WHISH_SERVICE_LABEL')?.trim() || 'Whish Money',
      accountName,
      accountNumber,
      reference: this.configService.get<string>('WHISH_ACCOUNT_REFERENCE')?.trim() || undefined,
      ifItFails:
        this.configService.get<string>('WHISH_FAILURE_NOTE')?.trim() ||
        'If the transfer fails or is reversed, nothing is charged and no plan ' +
        'starts. Contact support with your reference code and we will sort it out.',
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
