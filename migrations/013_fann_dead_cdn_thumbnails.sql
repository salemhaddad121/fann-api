-- =============================================================
-- 013: Clear thumbnails still pointing at the dead cdn.fann.app host
--
-- Migration 010 repointed the artist thumbnails and 012 did the media
-- rows, but two planner_profiles rows were missed: Joe Gemayel and Maya
-- Hajj, the two accounts 010 soft-deleted. Nothing renders them today —
-- both users are banned + deleted_at, so they are excluded from every
-- listing, and the admin user list draws initials rather than thumbnails.
-- This is tidy-up, not a user-visible fix.
--
-- cdn.fann.app was never a real host and the project is now on
-- fann.guru/R2, so the correct value is NULL (no thumbnail) rather than a
-- rewritten path — there is no local seed image for either of them.
-- The UI already handles a null thumbnail with an initials placeholder.
--
-- Scoped by the dead host rather than by user id, so it cleans up any
-- other row that still carries one and does nothing on a fresh database
-- where none exist.
--
-- Idempotent: re-running matches nothing once the rows are cleared.
-- =============================================================

UPDATE planner_profiles
   SET thumbnail_url = NULL
 WHERE thumbnail_url LIKE '%cdn.fann.app%';

UPDATE artist_profiles
   SET thumbnail_url = NULL
 WHERE thumbnail_url LIKE '%cdn.fann.app%';

UPDATE media
   SET cdn_url = NULL
 WHERE cdn_url LIKE '%cdn.fann.app%';
