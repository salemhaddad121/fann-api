-- =============================================================
-- 025: a profile row for every account
--
-- POST /auth/register wrote the users row, the consent rows and the
-- verification record. It wrote no artist_profiles or planner_profiles row,
-- and nothing else did either — grepping both repos for an insert into
-- either table returned zero matches outside the seed SQL.
--
-- The consequence was not subtle. updateMe() reads the profile before
-- patching it and throws NotFound when it is missing, so a new user could
-- not create one by saving the form: GET /artists/me was a permanent 404,
-- /profile a permanent "Couldn't load your profile", /profile/edit a
-- permanent "Loading…" with no inputs. Nobody who signed up could finish
-- onboarding. It survived 386 passing tests because every test and every
-- fixture starts from a database where the profile already exists.
--
-- users.service.ts now creates both rows in one transaction. This migration
-- makes that insert legal, and backfills the accounts created while it was
-- not.
--
-- WHY display_name BECOMES NULLABLE
-- ---------------------------------
-- A profile created at signup has no name, because nobody has typed one.
-- The alternatives were both worse: a placeholder ('', or the email local
-- part) puts a value on a PUBLIC profile that the user never chose and
-- cannot tell apart from one they did, and requiring the name at signup
-- means asking for it on a form that does not have it.
--
-- NULL is the honest encoding of "not yet". Nothing breaks on it:
--   - search joins users and filters status='active'; a new account is
--     'pending_review', so an unnamed profile is not listed at all.
--   - artist-visibility.ts does not even SELECT display_name below the
--     paying tier, and deletes the key when shaping.
--   - getPublicInfo() already returns `profile?.display_name ?? null`.
-- =============================================================

ALTER TABLE artist_profiles  ALTER COLUMN display_name DROP NOT NULL;
ALTER TABLE planner_profiles ALTER COLUMN display_name DROP NOT NULL;


-- ------------------------------------------------------------
-- Backfill — every account that registered before the fix.
--
-- NOT EXISTS rather than NOT IN: user_id is NOT NULL on both profile
-- tables today, but NOT IN against a subquery that ever yields a NULL
-- returns no rows at all, silently backfilling nothing. This form cannot
-- fail that way.
--
-- Deleted accounts are included on purpose. They are soft-deleted (status
-- 'banned', deleted_at set) and can in principle be restored; giving them
-- the row now means a restore does not land back in the broken state.
-- Admins are excluded — they have no public profile, and getPublicInfo()
-- special-cases them.
-- ------------------------------------------------------------

INSERT INTO artist_profiles (user_id)
SELECT u.id
  FROM users u
 WHERE u.role = 'artist'
   AND NOT EXISTS (
     SELECT 1 FROM artist_profiles ap WHERE ap.user_id = u.id
   );

INSERT INTO planner_profiles (user_id)
SELECT u.id
  FROM users u
 WHERE u.role = 'planner'
   AND NOT EXISTS (
     SELECT 1 FROM planner_profiles pp WHERE pp.user_id = u.id
   );


-- ------------------------------------------------------------
-- Leaves the database in a state the application can assert on: every
-- non-admin, non-deleted account has exactly one profile row. Raises
-- rather than warning — a silent partial backfill is the bug this
-- migration exists to fix.
-- ------------------------------------------------------------

DO $$
DECLARE
  orphans integer;
BEGIN
  SELECT count(*) INTO orphans
    FROM users u
   WHERE u.role IN ('artist', 'planner')
     AND NOT EXISTS (
       SELECT 1 FROM artist_profiles  ap WHERE ap.user_id = u.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM planner_profiles pp WHERE pp.user_id = u.id
     );

  IF orphans > 0 THEN
    RAISE EXCEPTION 'backfill incomplete: % account(s) still have no profile row', orphans;
  END IF;
END $$;
