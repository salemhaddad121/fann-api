-- =============================================================
-- 032: put the Venue category in the 'venues' bucket
--
-- The second half of 031, in its own file because the enum value it uses
-- has to be committed first. See 031 for the Postgres error that forces
-- the split.
--
-- SUPERSEDES AN ASSERTION IN 029. That migration ends by checking that the
-- Venue category has a NULL booker_interest, and at the time it did: a
-- booker looking for talent should not have been offered rooms. The
-- product decision has changed — bookers search for venues on purpose —
-- so the check in 029 is now a record of what was true then, not a rule.
-- A rebuild from zero runs 029's assertion before this file changes the
-- value, so the sequence still applies cleanly.
--
-- After this, NO category has a NULL bucket. The column stays nullable so
-- an existing row can never fail an upgrade, but the API no longer accepts
-- null when creating or editing one — a category in no bucket is invisible
-- to every booker and nothing at the time says so.
-- =============================================================

UPDATE categories SET booker_interest = 'venues' WHERE slug = 'venue';

DO $$
DECLARE
  unbucketed integer;
BEGIN
  SELECT count(*) INTO unbucketed FROM categories WHERE booker_interest IS NULL;
  IF unbucketed > 0 THEN
    RAISE EXCEPTION '% categor(y/ies) still have no booker bucket', unbucketed;
  END IF;
END $$;
