-- =============================================================
-- 011: Booker-type taxonomy
--
-- Gives each Booker (planner) a single "type" so Venues, Restaurants,
-- Wedding Planners, etc. are properly classified — powering the artist
-- dashboard "who books you, by type" metric and real venue modelling.
--
-- Numbered 011 (not 010) on purpose: 010_fann_seed_profile_refresh lives on
-- its own branch and is expected to land first, so this keeps numeric order
-- once both reach main. The gap is harmless (the runner is numeric-order).
--
-- Idempotent: safe to run by hand on an already-seeded DB, and again on a
-- fresh rebuild.
-- =============================================================

-- 1) The enum — a fixed list, matching how the app models user_role etc.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booker_type') THEN
    CREATE TYPE booker_type AS ENUM (
      'Event Planner', 'Venue', 'Restaurant', 'Bar', 'Wedding Planner', 'University', 'Other'
    );
  END IF;
END $$;

-- 2) The column — nullable; bookers set it in profile edit, unset is fine.
ALTER TABLE planner_profiles ADD COLUMN IF NOT EXISTS booker_type booker_type;

-- 3) Backfill the seeded bookers. Rows that don't exist on a given database
--    (e.g. Skyline Beirut only exists once migration 010 has run) are simple
--    no-ops, so this is safe on both fresh and already-seeded databases.
UPDATE planner_profiles SET booker_type = 'Event Planner'   WHERE id = '20000000-0000-0000-0000-000000000020'; -- Rania Saab (Saab Events)
UPDATE planner_profiles SET booker_type = 'Event Planner'   WHERE id = '20000000-0000-0000-0000-000000000021'; -- Joe Gemayel (Luxe Moments)
UPDATE planner_profiles SET booker_type = 'Wedding Planner' WHERE id = '20000000-0000-0000-0000-000000000022'; -- Maya Hajj (Beirut Weddings)
UPDATE planner_profiles SET booker_type = 'Event Planner'   WHERE id = '20000000-0000-0000-0000-000000000023'; -- Fadi Mansour (freelance organiser)
UPDATE planner_profiles SET booker_type = 'Venue'           WHERE id = '20000000-0000-0000-0000-000000000024'; -- Skyline Beirut (added by migration 010)
