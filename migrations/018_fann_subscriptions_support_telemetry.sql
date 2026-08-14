-- =============================================================
-- 018: subscriptions, payment provider integration, support
--      tickets, and guest telemetry
--
-- One file rather than six. Every block below is schema-only and has no
-- consumer yet; splitting them would mean six migrate/verify cycles
-- against the same tables for no isolation benefit.
--
-- Design notes:
--
--  * SUBSCRIPTIONS replace the implicit "a confirmed payment covers
--    period_start..period_end" model that 001 encoded directly on
--    `payments`. That model cannot express a paid-but-not-yet-started
--    day pass, which is the whole point of selling day access as
--    credits: payment confirmation is not instant here, so the 24h clock
--    must start when the buyer says so, not when the money lands.
--
--  * `status` carries the lifecycle, and the partial unique index is the
--    enforcement:
--      ready     — paid and confirmed, clock not started. Day-pass
--                  credits sit here indefinitely.
--      active    — clock running. At most ONE per user.
--      queued    — stacked purchase waiting for the current active row
--                  to expire. starts_at is set; expires_at is computed
--                  at promotion time, NOT at purchase time, so stacking
--                  survives an early cancellation or an admin fix-up.
--      expired / cancelled — terminal.
--
--  * subscription_plans is a table, not a constants file, because
--    requires_id_doc is a policy switch that will be argued about, and
--    price changes should not need a deploy. It is small and static
--    enough to cache.
--
--  * PAYMENTS gains provider columns so that plugging in a real gateway
--    later is a config change rather than a rewrite. Four of these earn
--    their place now specifically because adding them after live rows
--    exist becomes a data migration:
--      - the (provider, provider_ref) unique index is the idempotency
--        key. Providers retry webhooks; without it you double-mint.
--      - payment_webhook_events stores every inbound event BEFORE any
--        validation, signature-valid or not. It is the only way to debug
--        an integration you cannot reproduce locally.
--      - currency: Whish settles USD, OMT can settle LBP.
--      - the new status values. Postgres cannot remove enum values, so
--        the full intended lifecycle goes in now even though the manual
--        flow only uses two of them:
--          pending → awaiting_provider → paid → confirmed
--
--  * NOT the same as the existing `payment_service` enum, which spells
--    Whish Money as 'Wish'. That enum has seed data behind it and is
--    left alone; the new `provider` varchar is the forward-looking
--    field ('manual' | 'whish' | 'omt' | ...). Do not add a second
--    misspelling.
--
--  * period_start / period_end / transfer_service DROP NOT NULL. 001
--    required all three because a payment WAS a subscription period. A
--    purchase intent has no period until the resulting subscription is
--    activated, and a provider-routed payment has no local transfer
--    service at all. The CHECK (period_end > period_start) is left in
--    place — a CHECK passes when its expression is NULL.
--
--  * TELEMETRY: page_events was authenticated-only by design (see 014,
--    where role was the point). Guests are now the audience we most need
--    to understand, so user_id and role become nullable and session_id
--    carries continuity instead. session_id is a client-generated uuid
--    held in sessionStorage — it dies with the tab, is never a cookie,
--    and is never joined to an identity. That is what makes recording
--    guests defensible without a consent banner.
--
--  * The 014 design rules still hold and must not regress: `path` stores
--    the NORMALISED route ('/artists/[id]'), never a real URL, and
--    duration_ms is foreground-only via the Page Visibility API.
--
-- RETENTION: page_events and search_events are personal browsing
-- history, and search_events.query_text is free text a user typed.
-- Guest rows make the 90-day prune documented in 014 a live obligation
-- rather than a nice-to-have. Prune both:
--     DELETE FROM page_events   WHERE occurred_at < now() - interval '90 days';
--     DELETE FROM search_events WHERE occurred_at < now() - interval '90 days';
-- The scheduler wiring lands with the analytics work, not here.
--
-- TRANSACTION NOTE: scripts/migrate.sh runs each file with
-- --single-transaction. Postgres allows ALTER TYPE ... ADD VALUE inside
-- a transaction, but the new value CANNOT BE USED until that
-- transaction commits. Nothing below writes a row using
-- 'awaiting_provider', 'paid' or 'disputed', and nothing later in this
-- file may start to. Backfills using those values belong in 019.
-- (Values of plan_code and the other enums created here ARE usable in
-- this file — that restriction applies only to pre-existing types.)
--
-- Idempotent: IF NOT EXISTS guards throughout, enum creation wrapped in
-- DO blocks. Safe to re-run by hand on a seeded DB and on a fresh build.
-- =============================================================

-- -------------------------------------------------------------
-- Enums
-- -------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'plan_code') THEN
    CREATE TYPE plan_code AS ENUM ('day', 'month', 'year');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_status') THEN
    CREATE TYPE subscription_status AS ENUM
      ('ready', 'active', 'queued', 'expired', 'cancelled');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'support_ticket_status') THEN
    CREATE TYPE support_ticket_status AS ENUM
      ('open', 'in_progress', 'resolved', 'closed');
  END IF;
END $$;

-- -------------------------------------------------------------
-- subscription_plans — the price list
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscription_plans (
  code            plan_code     PRIMARY KEY,
  price_usd       NUMERIC(10,2) NOT NULL CHECK (price_usd >= 0),
  duration_days   INT           NOT NULL CHECK (duration_days > 0),
  -- The day pass deliberately skips identity verification: it is a $5
  -- look-around, and an ID upload wall would kill it. Month and year
  -- keep the requirement. Gates branch on this flag, never on a
  -- hardcoded plan name.
  requires_id_doc BOOLEAN       NOT NULL DEFAULT true,
  -- Day passes are sold as credits and capped, because $5 with no ID
  -- check is otherwise an invitation to sweep the whole artist roster.
  -- NULL means uncapped.
  message_cap     INT           CHECK (message_cap IS NULL OR message_cap > 0),
  is_active       BOOLEAN       NOT NULL DEFAULT true,
  sort_order      INT           NOT NULL
);

INSERT INTO subscription_plans
  (code, price_usd, duration_days, requires_id_doc, message_cap, is_active, sort_order)
VALUES
  ('day',     5.00,   1, false,   15, true, 1),
  ('month',  15.00,  30, true,  NULL, true, 2),
  ('year',  100.00, 365, true,  NULL, true, 3)
ON CONFLICT (code) DO NOTHING;

-- -------------------------------------------------------------
-- subscriptions
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
  id           UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID                NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan_code    plan_code           NOT NULL REFERENCES subscription_plans (code),
  -- SET NULL rather than CASCADE: an admin voiding a bad payment row
  -- must not silently delete access the user has already been granted.
  payment_id   UUID                REFERENCES payments (id) ON DELETE SET NULL,
  status       subscription_status NOT NULL DEFAULT 'ready',
  activated_at TIMESTAMPTZ,
  starts_at    TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ         NOT NULL DEFAULT now()
);

-- The one-active-subscription rule, enforced by the database rather than
-- by service code. Two concurrent confirmations cannot both win.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_sub_per_user
  ON subscriptions (user_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
  ON subscriptions (user_id, status);

-- Drives the expiry cron: only active rows are ever swept.
CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry
  ON subscriptions (expires_at) WHERE status = 'active';

-- Drives promotion: pick the oldest queued row for a user.
CREATE INDEX IF NOT EXISTS idx_subscriptions_queued
  ON subscriptions (user_id, created_at) WHERE status = 'queued';

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------------------
-- payments — provider integration
-- -------------------------------------------------------------

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS plan_code         plan_code,
  ADD COLUMN IF NOT EXISTS quantity          INT         NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS provider          VARCHAR(30) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS provider_ref      VARCHAR(120),
  ADD COLUMN IF NOT EXISTS provider_payload  JSONB,
  ADD COLUMN IF NOT EXISTS currency          VARCHAR(3)  NOT NULL DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS intent_expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_quantity_positive'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_quantity_positive CHECK (quantity > 0);
  END IF;
END $$;

-- See header: a purchase intent has no period yet, and a provider-routed
-- payment has no local transfer service.
ALTER TABLE payments ALTER COLUMN period_start     DROP NOT NULL;
ALTER TABLE payments ALTER COLUMN period_end       DROP NOT NULL;
ALTER TABLE payments ALTER COLUMN transfer_service DROP NOT NULL;

-- The idempotency key. Providers retry; this is what stops a replayed
-- webhook from minting a second subscription.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_ref
  ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- Drives the reconciliation job: intents left hanging with a provider.
CREATE INDEX IF NOT EXISTS idx_payments_intent_expiry
  ON payments (intent_expires_at) WHERE intent_expires_at IS NOT NULL;

-- Added, not used, in this transaction. See the TRANSACTION NOTE above.
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'awaiting_provider';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'paid';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'disputed';

-- -------------------------------------------------------------
-- payment_webhook_events — the inbound audit log
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      VARCHAR(30) NOT NULL,
  provider_ref  VARCHAR(120),
  event_type    VARCHAR(60),
  -- Recorded, not enforced. A failed signature is written down and
  -- answered 200, because a 4xx makes most providers retry forever.
  signature_ok  BOOLEAN     NOT NULL,
  raw_body      TEXT        NOT NULL,
  headers       JSONB       NOT NULL DEFAULT '{}',
  payment_id    UUID        REFERENCES payments (id) ON DELETE SET NULL,
  processed_at  TIMESTAMPTZ,
  process_error TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_ref
  ON payment_webhook_events (provider, provider_ref);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_unprocessed
  ON payment_webhook_events (received_at) WHERE processed_at IS NULL;

-- -------------------------------------------------------------
-- artist_profiles — deposit and cancellation terms
-- -------------------------------------------------------------

-- NULL and 0 both mean "no deposit required". Numeric only: a free-text
-- deposit field cannot be compared, summed, or shown in a filter.
ALTER TABLE artist_profiles
  ADD COLUMN IF NOT EXISTS deposit_usd         NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS cancellation_policy TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'artist_profiles_deposit_non_negative'
  ) THEN
    ALTER TABLE artist_profiles
      ADD CONSTRAINT artist_profiles_deposit_non_negative
      CHECK (deposit_usd IS NULL OR deposit_usd >= 0);
  END IF;
END $$;

-- -------------------------------------------------------------
-- support_tickets
-- -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS support_tickets (
  id          UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL user_id means a guest raised it. SET NULL on delete keeps the
  -- ticket history intact after an account closure.
  user_id     UUID                  REFERENCES users (id) ON DELETE SET NULL,
  guest_email VARCHAR(255),
  guest_name  VARCHAR(150),
  subject     VARCHAR(200)          NOT NULL,
  body        TEXT                  NOT NULL,
  status      support_ticket_status NOT NULL DEFAULT 'open',
  -- Normalised route the ticket was raised from, same rule as
  -- page_events.path — never a real URL.
  source_path TEXT,
  assigned_to UUID                  REFERENCES users (id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ           NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ           NOT NULL DEFAULT now(),
  -- Every ticket must be answerable: either it belongs to an account or
  -- it carries a guest address.
  CHECK (user_id IS NOT NULL OR guest_email IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status
  ON support_tickets (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user
  ON support_tickets (user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON support_tickets;
CREATE TRIGGER trg_support_tickets_updated_at
  BEFORE UPDATE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID        NOT NULL REFERENCES support_tickets (id) ON DELETE CASCADE,
  author_id  UUID        REFERENCES users (id) ON DELETE SET NULL,
  -- Denormalised so a reply still reads as staff after the staff account
  -- is deleted and author_id goes NULL.
  is_staff   BOOLEAN     NOT NULL DEFAULT false,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket
  ON support_ticket_messages (ticket_id, created_at);

-- -------------------------------------------------------------
-- Telemetry — guests
-- -------------------------------------------------------------

ALTER TABLE page_events ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE page_events ALTER COLUMN role    DROP NOT NULL;

ALTER TABLE page_events
  ADD COLUMN IF NOT EXISTS session_id UUID,
  -- Existing rows are all authenticated, so false backfills correctly.
  ADD COLUMN IF NOT EXISTS is_guest   BOOLEAN NOT NULL DEFAULT false;

-- Session duration is SUM(duration_ms) GROUP BY session_id, so the index
-- leads on session_id.
CREATE INDEX IF NOT EXISTS idx_page_events_session
  ON page_events (session_id, occurred_at);

CREATE TABLE IF NOT EXISTS search_events (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID,
  user_id      UUID        REFERENCES users (id) ON DELETE SET NULL,
  is_guest     BOOLEAN     NOT NULL DEFAULT false,
  category_id  UUID        REFERENCES categories (id) ON DELETE SET NULL,
  -- Free text the user typed. Covered by the 90-day prune above.
  query_text   TEXT,
  filters      JSONB       NOT NULL DEFAULT '{}',
  result_count INT         CHECK (result_count IS NULL OR result_count >= 0),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Category demand, ranked over a window.
CREATE INDEX IF NOT EXISTS idx_search_events_category
  ON search_events (category_id, occurred_at DESC);

-- The time-window filter every aggregate starts with, and the prune.
CREATE INDEX IF NOT EXISTS idx_search_events_occurred
  ON search_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_search_events_session
  ON search_events (session_id, occurred_at);
