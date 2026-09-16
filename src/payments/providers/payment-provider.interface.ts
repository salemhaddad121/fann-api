/**
 * The contract every payment provider implements.
 *
 * Three shapes have to fit through this, and they are genuinely different:
 *
 *   - hosted redirect — a card gateway or a Whish payment link, where the
 *     customer leaves the site and comes back
 *   - reference matching — OMT-style, where the customer pays at a branch
 *     quoting a code and nothing happens online at all
 *   - manual — our current flow, where an admin confirms a bank transfer
 *
 * `redirectUrl` and `instructions` cover the first two; a provider returns
 * whichever it has. The optional `getStatus` covers providers that offer
 * polling instead of webhooks, which is the likely shape for a
 * reference-matching service — for those, polling is the primary path and
 * not a fallback.
 *
 * Adding a real provider should be: write one class, set env vars, flip a
 * config flag. No changes to the service, the controller, the schema, or
 * the frontend.
 */

/**
 * Who to pay, for a flow where the buyer moves the money themselves.
 *
 * Structured rather than appended to `instructions`, and that is the whole
 * point of it existing. An account number inside a prose sentence cannot be
 * rendered as the most prominent thing on the screen, cannot be given a
 * copy button, and cannot be checked for presence — which is how the
 * payment step shipped saying "Transfer $5.55. Quote reference PLN-000015."
 * and never once saying who to send it to.
 */
export interface PaymentRecipient {
  /** Which service the transfer is made through, e.g. "Whish Money". */
  service: string;
  /** The name the account is registered under. Buyers check this. */
  accountName: string;
  /** Account number, or the phone number a wallet is keyed by. */
  accountNumber: string;
  /** Branch, IBAN or anything else the service needs. Often absent. */
  reference?: string;
  /** What to do if the transfer fails, bounces or is reversed. */
  ifItFails: string;
}

export interface PaymentIntent {
  /** The provider's own id for this payment. Our idempotency key. */
  providerRef: string;
  /** Hosted checkout or payment link, when the provider has one. */
  redirectUrl?: string;
  /** Human instructions, for reference-matching flows with no redirect. */
  instructions?: string;
  /** Where to send the money, for flows where the buyer transfers it. */
  recipient?: PaymentRecipient;
  expiresAt?: Date;
}

export interface ParsedWebhook {
  providerRef: string;
  status: 'paid' | 'failed' | 'expired' | 'unknown';
  /** Checked against the stored intent before anything is granted. */
  amount: number;
  currency: string;
  /** Provider's own event name, recorded for debugging. */
  eventType?: string;
}

export interface CreateIntentInput {
  paymentId: string;
  amountUsd: number;
  currency: string;
  userId: string;
  /** users.account_code — the reconciliation key for reference matching. */
  accountCode: string;
  planCode: string;
  quantity: number;
}

export interface PaymentProvider {
  /** Matches payments.provider and the :provider webhook path segment. */
  readonly code: string;

  createIntent(input: CreateIntentInput): Promise<PaymentIntent>;

  /**
   * Verifies the signature over the EXACT bytes the provider sent.
   *
   * Takes a Buffer, never a parsed object: the signature is an HMAC over
   * the raw body, and re-serialising parsed JSON does not reproduce those
   * bytes — key order, whitespace and number formatting are all free to
   * change. This is why main.ts enables rawBody.
   */
  verifySignature(rawBody: Buffer, headers: Record<string, string>): boolean;

  parseWebhook(rawBody: Buffer): ParsedWebhook;

  /**
   * Optional polling, for providers with no webhook. The reconciliation
   * job uses this; providers without it are simply skipped.
   */
  getStatus?(providerRef: string): Promise<ParsedWebhook['status']>;
}
