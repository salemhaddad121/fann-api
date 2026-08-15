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

export interface PaymentIntent {
  /** The provider's own id for this payment. Our idempotency key. */
  providerRef: string;
  /** Hosted checkout or payment link, when the provider has one. */
  redirectUrl?: string;
  /** Human instructions, for reference-matching flows with no redirect. */
  instructions?: string;
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
