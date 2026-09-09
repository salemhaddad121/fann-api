/**
 * VAT on subscription payments.
 *
 * Lebanon's standard rate is 11%, which is the default here. It is read
 * from config rather than hardcoded so the rate can move without a deploy,
 * and — the reason that matters more right now — so it can be held at zero.
 *
 * ⚠️ Charging VAT is lawful once Fann holds a tax registration number,
 * which is item 4 of GO-LIVE-BLOCKERS.md and still open. Setting
 * `VAT_RATE=0` turns the whole thing off: no tax is added, no VAT line is
 * shown, and the "Excluding VAT" note disappears from the plan cards,
 * because at a zero rate every one of those statements would be false.
 * That is the switch to use if registration has not landed yet.
 *
 * A stored rate on the payment row is what makes a past receipt stable —
 * see migration 022. Nothing here should ever be used to recompute the tax
 * on a payment that has already been taken.
 */

export const DEFAULT_VAT_RATE = 0.11;

export interface VatBreakdown {
  /** Net, as given. */
  subtotalUsd: number;
  /** The rate actually applied, after validation. */
  vatRate: number;
  /** Tax, rounded to cents exactly once. */
  vatUsd: number;
  /** What the buyer pays. */
  totalUsd: number;
}

/**
 * Reads and validates the configured rate.
 *
 * An unparseable or out-of-range value falls back to zero rather than to
 * the default. A typo in an env var should under-charge and be noticed in
 * the books, not over-charge a customer and be noticed in a complaint —
 * and silently substituting 11% for a value someone deliberately set is
 * how a "temporary" hold gets ignored.
 */
export function resolveVatRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_VAT_RATE;

  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return 0;
  return rate;
}

/**
 * Splits a net amount into net, tax and gross.
 *
 * Rounds in cents rather than on the float: 15 * 0.11 is 1.6500000000000001
 * in IEEE 754, and toFixed on the total after adding it produces a figure
 * that does not equal subtotal + vat. Rounding the tax once, to cents, and
 * summing from there keeps the three numbers consistent with each other —
 * which is the property an invoice needs.
 */
export function vatBreakdown(subtotalUsd: number, vatRate: number): VatBreakdown {
  const vatUsd = Math.round(subtotalUsd * vatRate * 100) / 100;

  return {
    subtotalUsd,
    vatRate,
    vatUsd,
    totalUsd: Math.round((subtotalUsd + vatUsd) * 100) / 100,
  };
}
