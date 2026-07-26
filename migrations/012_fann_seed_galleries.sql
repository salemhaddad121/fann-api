-- =============================================================
-- 012: Seed gallery media (Step 2 of the seed refresh)
--
-- Step 1 (migration 010) fixed the profile *thumbnails*. This fixes the
-- *galleries*: the seeded media/portfolio rows still pointed at the dead
-- cdn.fann.app host. Here we:
--   A) repoint every seeded photo row to a local /seed/ image,
--   B) drop the two seeded video rows (there are no local video assets),
--   C) enrich — a 2nd photo for Marwan & Tony, and full galleries for
--      Sara Frem and the rock band Cedar & Smoke (both had no media).
--
-- Idempotent: safe to run by hand on a seeded DB and again on a fresh
-- rebuild (UPDATEs are by unique s3_key; INSERTs are guarded by NOT EXISTS).
-- =============================================================

-- A) Repoint existing photo rows -------------------------------------------
UPDATE media SET cdn_url = '/seed/karim-nassar.jpg'    WHERE s3_key = 'artists/karim-nassar/primary.jpg';
UPDATE media SET cdn_url = '/seed/gallery/karim-2.jpg' WHERE s3_key = 'artists/karim-nassar/set-1.jpg';
UPDATE media SET cdn_url = '/seed/gallery/karim-3.jpg' WHERE s3_key = 'artists/karim-nassar/set-2.jpg';
UPDATE media SET cdn_url = '/seed/layla-khoury.png'    WHERE s3_key = 'artists/layla-khoury/primary.jpg';
UPDATE media SET cdn_url = '/seed/gallery/layla-2.png' WHERE s3_key = 'artists/layla-khoury/portfolio-1.jpg';
UPDATE media SET cdn_url = '/seed/gallery/layla-3.png' WHERE s3_key = 'artists/layla-khoury/portfolio-2.jpg';
UPDATE media SET cdn_url = '/seed/marwan-quartet.jpg'  WHERE s3_key = 'artists/marwan-quartet/primary.jpg';
UPDATE media SET cdn_url = '/seed/nour-el-hage.jpg'    WHERE s3_key = 'artists/nour-el-hage/primary.jpg';
UPDATE media SET cdn_url = '/seed/tony-rizk.png'       WHERE s3_key = 'artists/tony-rizk/primary.jpg';

-- B) Remove seeded video rows (no local video files) -----------------------
DELETE FROM media
 WHERE media_type = 'video'
   AND s3_key IN ('artists/karim-nassar/showreel.mp4', 'artists/marwan-quartet/live-set.mp4');

-- C) Enrich galleries. media has no natural unique key, so each INSERT is
--    guarded on its synthetic s3_key to stay idempotent. 500 KB is a
--    plausible photo size, well under the 10 MB CHECK.
INSERT INTO media (user_id, media_type, s3_key, cdn_url, file_size_bytes, is_primary, sort_order)
SELECT '00000000-0000-0000-0000-000000000012', 'photo', 'seed/marwan-quartet/2', '/seed/gallery/marwan-2.jpg', 500000, FALSE, 1
 WHERE NOT EXISTS (SELECT 1 FROM media WHERE s3_key = 'seed/marwan-quartet/2');

INSERT INTO media (user_id, media_type, s3_key, cdn_url, file_size_bytes, is_primary, sort_order)
SELECT '00000000-0000-0000-0000-000000000015', 'photo', 'seed/tony-rizk/2', '/seed/gallery/tony-2.png', 500000, FALSE, 1
 WHERE NOT EXISTS (SELECT 1 FROM media WHERE s3_key = 'seed/tony-rizk/2');

-- Sara Frem (dancer) — had no media
INSERT INTO media (user_id, media_type, s3_key, cdn_url, file_size_bytes, is_primary, sort_order)
SELECT '00000000-0000-0000-0000-000000000014', 'photo', 'seed/sara-frem/1', '/seed/sara-frem.jpg', 500000, TRUE, 0
 WHERE NOT EXISTS (SELECT 1 FROM media WHERE s3_key = 'seed/sara-frem/1');
INSERT INTO media (user_id, media_type, s3_key, cdn_url, file_size_bytes, is_primary, sort_order)
SELECT '00000000-0000-0000-0000-000000000014', 'photo', 'seed/sara-frem/2', '/seed/gallery/sara-2.jpg', 500000, FALSE, 1
 WHERE NOT EXISTS (SELECT 1 FROM media WHERE s3_key = 'seed/sara-frem/2');

-- Cedar & Smoke (rock band, added by migration 010) — had no media
INSERT INTO media (user_id, media_type, s3_key, cdn_url, file_size_bytes, is_primary, sort_order)
SELECT '00000000-0000-0000-0000-000000000016', 'photo', 'seed/cedar-and-smoke/1', '/seed/cedar-and-smoke.jpg', 500000, TRUE, 0
 WHERE NOT EXISTS (SELECT 1 FROM media WHERE s3_key = 'seed/cedar-and-smoke/1');
INSERT INTO media (user_id, media_type, s3_key, cdn_url, file_size_bytes, is_primary, sort_order)
SELECT '00000000-0000-0000-0000-000000000016', 'photo', 'seed/cedar-and-smoke/2', '/seed/gallery/band-2.jpg', 500000, FALSE, 1
 WHERE NOT EXISTS (SELECT 1 FROM media WHERE s3_key = 'seed/cedar-and-smoke/2');
