import { Injectable, NotImplementedException } from '@nestjs/common';
import {
  PaymentIntent,
  ParsedWebhook,
  PaymentProvider,
} from './payment-provider.interface';

/**
 * OMT. Not implemented — no merchant account yet.
 *
 * Expected to be a reference-matching flow rather than a hosted checkout:
 * the customer pays at a branch quoting a code, and reconciliation happens
 * afterwards. If that is right, this provider will implement `instructions`
 * and `getStatus` rather than `redirectUrl`, and polling will be the
 * primary path with no webhook at all.
 *
 * That is the reason users.account_code is kept and shown prominently on
 * the payment screen: under reference matching it is the only thing tying
 * an incoming transfer to an account.
 *
 * See README.md in this folder for what credentials this will need.
 */
@Injectable()
export class OmtProvider implements PaymentProvider {
  readonly code = 'omt';

  async createIntent(): Promise<PaymentIntent> {
    throw new NotImplementedException('OMT is not configured yet. Use the manual flow.');
  }

  verifySignature(): boolean {
    return false;
  }

  parseWebhook(): ParsedWebhook {
    throw new NotImplementedException('OMT webhooks are not implemented.');
  }
}
