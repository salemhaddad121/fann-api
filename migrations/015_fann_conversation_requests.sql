-- =============================================================
-- 015: conversation requests — artists can start conversations
--
-- Until now only planners could open a thread; messaging.service.ts threw
-- ForbiddenException('Only planners can start conversations.') for
-- everyone else, so an artist had no way to contact a planner at all.
--
-- Artists may now initiate, but a thread they start is a *request*: it
-- stays pending until the planner accepts, which keeps artist -> planner
-- cold outreach from landing straight in a planner's inbox.
--
-- Design notes:
--
--  * status defaults to 'accepted'. Every existing row was
--    planner-initiated, and a planner starting a thread with an artist
--    they're considering needs no approval — that direction is the
--    product's normal flow. Only the new artist-initiated direction
--    starts at 'pending'.
--
--  * initiated_by records who opened the thread. It's needed to decide
--    who may respond to a pending request, and can't be inferred from
--    the first message (there may not be one yet).
--
--  * 'declined' is a terminal state rather than a row delete, so a
--    declined artist can't simply re-request in a loop. The unique
--    (artist_id, planner_id) constraint already prevents a second row.
--
-- Idempotent: safe to run by hand on an already-seeded DB, and again on
-- a fresh rebuild.
-- =============================================================

-- 1) The enum — a fixed list, matching how the app models user_role etc.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'conversation_status') THEN
    CREATE TYPE conversation_status AS ENUM ('pending', 'accepted', 'declined');
  END IF;
END $$;

-- 2) Columns. Existing rows take the 'accepted' default, which is what
--    they effectively already were.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS status conversation_status NOT NULL DEFAULT 'accepted';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS initiated_by UUID REFERENCES users (id) ON DELETE SET NULL;

-- 3) Backfill initiated_by for pre-existing threads. All of them were
--    planner-initiated by construction, since that was the only path.
UPDATE conversations SET initiated_by = planner_id WHERE initiated_by IS NULL;

-- 4) A planner's pending-request list is read on every inbox load, so
--    index the lookup it drives.
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations (status);
