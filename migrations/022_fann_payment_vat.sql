-- =============================================================
-- 022: VAT on subscription payments
--
-- Fann is becoming VAT-registered, so a payment stops being one number.
-- A tax invoice has to state the net, the rate, the tax and the gross —
-- and it has to keep stating them years later, after the rate has moved.
--
-- Which is the reason vat_rate is stored on the ROW rather than read from
-- config at display time. Config answers "what is the rate today"; an
-- invoice needs "what was the rate when this was charged". Deriving the
-- historical figure from today's setting silently rewrites every past
-- receipt the first time Lebanon changes the rate.
--
-- amount_usd keeps its meaning: the GROSS total, the figure the buyer
-- actually transfers and the one the webhook reconciles against
-- (webhooks.service.ts compares the provider's amount to it). Changing
-- that meaning instead — net here, gross computed — would have made every
-- existing reconciliation path quietly wrong.
--
--   subtotal_usd  net, price x quantity
--   vat_rate      the rate applied, e.g. 0.1100
--   vat_usd       the tax, rounded to cents once
--   amount_usd    subtotal_usd + vat_usd   (unchanged column, unchanged role)
--
-- The backfill is a factual claim, not a convenience: every payment that
-- exists today was taken before registration, so all of it was net and
-- none of it was tax. Defaulting the rate to 0 says exactly that.
--
-- Idempotent: guarded throughout.
-- =============================================================

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS subtotal_usd NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS vat_rate     NUMERIC(5,4)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_usd      NUMERIC(10,2) NOT NULL DEFAULT 0;

UPDATE payments SET subtotal_usd = amount_usd WHERE subtotal_usd IS NULL;

-- subtotal_usd stays NULLABLE, on purpose, and this is the one decision in
-- this file that is not about tax.
--
-- Migrations are applied to Neon BEFORE the code that uses them is deployed
-- (see the deploy notes), so for the length of that window the CURRENTLY
-- RUNNING code is writing these rows. That code does not know this column
-- exists: createPaymentIntent inserts planner_id, plan_code, quantity,
-- amount_usd, currency, provider, status, transfer_service, reference_code
-- and nothing else. A NOT NULL column with no default would therefore make
-- every POST /payments fail with a constraint violation from the moment
-- this file is applied until the deploy lands — the same shape of outage as
-- migration 015 on 2026-07-31, just triggered from the other direction.
--
-- A DEFAULT would avoid the crash and is worse: it would silently write a
-- subtotal of 0 against a real amount, and a payment row that disagrees
-- with itself is harder to notice than one with a hole in it.
--
-- So: expand now, contract later. Rows written during the window have
-- subtotal_usd NULL, which is readable as "taken by pre-VAT code" and is
-- true. Once the deploy is live and no such rows remain, a follow-up
-- migration can add the NOT NULL.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_vat_rate_sane'
  ) THEN
    -- A rate outside 0..1 is a misconfigured env var reaching the database,
    -- and it would be discovered as a wrong charge rather than as an error.
    ALTER TABLE payments
      ADD CONSTRAINT payments_vat_rate_sane CHECK (vat_rate >= 0 AND vat_rate <= 1);
  END IF;
END $$;

COMMENT ON COLUMN payments.subtotal_usd IS 'Net of VAT: plan price x quantity. NULL only on rows written by pre-VAT code during the 022 deploy window.';
COMMENT ON COLUMN payments.vat_rate IS 'The rate applied AT THE TIME of this payment. Never re-read from config for a past row.';
COMMENT ON COLUMN payments.amount_usd IS 'GROSS total the buyer transfers: subtotal_usd + vat_usd.';
