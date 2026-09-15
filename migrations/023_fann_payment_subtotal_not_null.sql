-- =============================================================
-- 023: finish what 022 started — subtotal_usd becomes NOT NULL
--
-- This is the contract half of an expand/contract pair. 022 added
-- subtotal_usd NULLABLE on purpose: migrations are applied to production
-- BEFORE the code that uses them is deployed, so for the length of that
-- window the running code was still writing payment rows without this
-- column. A NOT NULL with no default would have made every POST /payments
-- fail on a constraint violation from the moment 022 landed until the
-- deploy completed.
--
-- That window closed on 2026-09-10 when the VAT code went live. Every
-- payment written since carries a real subtotal, so the column can now say
-- what has been true of the data all along.
--
-- The backfill is not defensive padding, it is the correctness argument.
-- Any row still holding NULL was taken by pre-VAT code, which charged no
-- tax — so for those rows the amount charged WAS the net amount, and
-- subtotal_usd = amount_usd is the true value rather than a placeholder.
-- Writing it makes the invoice arithmetic hold for every row in the table:
-- subtotal + vat = amount, with vat already defaulted to 0 for them.
--
-- Self-healing by design: it does not matter whether production has zero
-- such rows or a hundred. Running this against a clean table is a no-op
-- UPDATE followed by a constraint that was already satisfied, which is
-- what makes it safe to apply without checking first.
--
-- Deploy order: unlike 022 this one is safe in EITHER direction. The
-- currently-deployed code already writes subtotal_usd on every insert, so
-- tightening the column cannot break it, and no code change accompanies
-- this file.
--
-- Idempotent: the UPDATE matches nothing on a second run, and SET NOT NULL
-- on an already-NOT NULL column is accepted without error.
-- =============================================================

UPDATE payments
   SET subtotal_usd = amount_usd
 WHERE subtotal_usd IS NULL;

ALTER TABLE payments
  ALTER COLUMN subtotal_usd SET NOT NULL;

COMMENT ON COLUMN payments.subtotal_usd IS
  'Net of VAT: plan price x quantity. NOT NULL since 023 — the pre-VAT deploy window that required it to be nullable is closed.';
