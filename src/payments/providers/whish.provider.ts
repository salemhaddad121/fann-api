import { Injectable, NotImplementedException } from '@nestjs/common';
import {
  PaymentIntent,
  ParsedWebhook,
  PaymentProvider,
} from './payment-provider.interface';

/**
 * Whish Money. Not implemented — no merchant account yet.
 *
 * Note the spelling. The payment_service enum from migration 001 has
 * 'Wish', which is wrong, but it has seed data behind it and Postgres
 * cannot rename an enum value in place without a migration nobody needs
 * right now. The forward-looking field is payments.provider, and it spells
 * this correctly. Do not add a second misspelling.
 *
 * See README.md in this folder for what credentials this will need.
 */
@Injectable()
export class WhishProvider implements PaymentProvider {
  readonly code = 'whish';

  async createIntent(): Promise<PaymentIntent> {
    throw new NotImplementedException(
      'Whish Money is not configured yet. Use the manual flow.',
    );
  }

  verifySignature(): boolean {
    // Refuse rather than throw. An unconfigured provider receiving a
    // webhook should record the attempt and answer 200 like any other
    // failed signature, not 500 and invite a retry storm.
    return false;
  }

  parseWebhook(): ParsedWebhook {
    throw new NotImplementedException('Whish Money webhooks are not implemented.');
  }
}
