-- =============================================================
-- 024: what a report is actually about
--
-- The in-context report action (blocker item 36) files an ordinary support
-- ticket and writes the reported account into the BODY as prose:
--
--   Reported artist profile: 00000000-0000-0000-0000-000000000011
--   Reason: Trying to take a booking off the platform
--   <what the reporter typed>
--
-- That is readable, and it is enough for one admin acting on one ticket.
-- It is not enough for the questions that matter once there is more than a
-- handful: how many reports does this account have, has anyone reported
-- them before, show me every open report against artists. Prose cannot be
-- filtered, counted or joined, so today those questions are answered by
-- reading tickets one at a time.
--
-- Two columns, deliberately not a foreign key to users:
--
--   reported_kind  'artist' | 'planner' | 'conversation'
--   reported_id    the profile or conversation id
--
-- No FK because the id points at different tables depending on kind, and
-- because a report must survive the thing it is about. Deleting an account
-- that has been reported must not cascade away the evidence that it was —
-- that is the record of why it was deleted.
--
-- Both nullable: the great majority of tickets are ordinary support
-- requests with no target at all, and /help will keep producing them.
-- A CHECK keeps the pair honest — either both are set or neither is, so a
-- kind with no id (or the reverse) cannot be stored.
--
-- Existing report tickets are NOT backfilled. Their references live in
-- prose written by the reporter, and parsing free text into a typed column
-- would be guessing at data an admin can already read correctly. They stay
-- as they are; new reports are structured.
--
-- Idempotent: guarded throughout.
-- =============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_target_kind') THEN
    CREATE TYPE report_target_kind AS ENUM ('artist', 'planner', 'conversation');
  END IF;
END $$;

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS reported_kind report_target_kind,
  ADD COLUMN IF NOT EXISTS reported_id   UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'support_tickets_report_target_pair'
  ) THEN
    ALTER TABLE support_tickets
      ADD CONSTRAINT support_tickets_report_target_pair
      CHECK (num_nonnulls(reported_kind, reported_id) <> 1);
  END IF;
END $$;

-- The query this exists to make cheap: every report against one account,
-- newest first. Partial, because only a small minority of tickets are
-- reports and indexing the NULLs would be dead weight.
CREATE INDEX IF NOT EXISTS idx_support_tickets_reported
  ON support_tickets (reported_kind, reported_id, created_at DESC)
  WHERE reported_id IS NOT NULL;

COMMENT ON COLUMN support_tickets.reported_id IS
  'The profile or conversation this report is about. Deliberately NOT a foreign key: the target table depends on reported_kind, and a report must outlive the account it concerns.';
