-- =============================================================
-- 010: Seed profile refresh
--
-- What this does:
--   1. Repoints every seeded thumbnail_url away from the dead
--      https://cdn.fann.app host to local images served by the
--      frontend from /public/seed/ (relative "/seed/…" URLs).
--   2. Adds two new demo profiles:
--        - Artist : rock band "Cedar & Smoke"  (account ART-000007)
--        - Booker : venue     "Skyline Beirut"  (account PLN-000005)
--   3. Hides bookers Joe Gemayel (…021) and Maya Hajj (…022) using
--      the app's own soft-delete state (status='banned' + deleted_at).
--      Search & login already exclude non-'active' users, so they
--      disappear from the app while their bookings/reviews stay intact.
--
-- Notes:
--   * Migrations only auto-run on a FRESH database. This file is also
--     safe to run BY HAND against an already-seeded DB: every statement
--     is idempotent, so re-running it changes nothing.
--   * The two new accounts use the shared dev password (same bcrypt
--     hash as every other seed account): Fann@dev2025
--   * Hiding is reversible: to bring Joe/Maya back, set
--     status='active', deleted_at=NULL for their user rows.
-- =============================================================

-- 1) Repoint existing thumbnails to local /seed/ images ---------------------
UPDATE artist_profiles  SET thumbnail_url = '/seed/karim-nassar.jpg'   WHERE id = '10000000-0000-0000-0000-000000000010'; -- DJ Karim
UPDATE artist_profiles  SET thumbnail_url = '/seed/layla-khoury.png'   WHERE id = '10000000-0000-0000-0000-000000000011'; -- Layla Khoury (photographer)
UPDATE artist_profiles  SET thumbnail_url = '/seed/marwan-quartet.jpg' WHERE id = '10000000-0000-0000-0000-000000000012'; -- The Marwan Quartet
UPDATE artist_profiles  SET thumbnail_url = '/seed/nour-el-hage.jpg'   WHERE id = '10000000-0000-0000-0000-000000000013'; -- Nour El Hage (MC)
UPDATE artist_profiles  SET thumbnail_url = '/seed/sara-frem.jpg'      WHERE id = '10000000-0000-0000-0000-000000000014'; -- Sara Frem (dancer; was NULL)
UPDATE artist_profiles  SET thumbnail_url = '/seed/tony-rizk.png'      WHERE id = '10000000-0000-0000-0000-000000000015'; -- DJ Tony R
UPDATE planner_profiles SET thumbnail_url = '/seed/rania-saab.png'     WHERE id = '20000000-0000-0000-0000-000000000020'; -- Rania Saab (booker)

-- 2a) New artist: rock band "Cedar & Smoke" ---------------------------------
INSERT INTO users
  (id, email, phone, password_hash, role, status, account_code,
   email_verified_at, phone_verified_at, created_at)
VALUES
  ('00000000-0000-0000-0000-000000000016',
   'band.cedarandsmoke@gmail.com', '+9613001007',
   '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
   'artist', 'active', 'ART-000007',
   NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO artist_profiles
  (id, user_id, display_name, bio, location_city, location_country,
   base_price_usd, languages, social_links, is_verified, thumbnail_url, created_at)
VALUES
  ('10000000-0000-0000-0000-000000000016',
   '00000000-0000-0000-0000-000000000016',
   'Cedar & Smoke',
   'Five-piece rock band out of Beirut — high-energy covers and originals spanning indie, classic rock, and Arabic-rock crossovers. A regular on the Mar Mikhael rooftop circuit. Full PA and lighting rig available.',
   'Beirut', 'Lebanon',
   650.00,
   '["Arabic","English","French"]',
   '{"instagram":"https://instagram.com/cedarandsmoke.band","youtube":"https://youtube.com/@cedarandsmoke"}',
   TRUE,
   '/seed/cedar-and-smoke.jpg',
   NOW() - INTERVAL '30 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO artist_categories (artist_profile_id, category_id)
  SELECT '10000000-0000-0000-0000-000000000016', id FROM categories WHERE slug = 'band-group'
ON CONFLICT DO NOTHING;

-- 2b) New booker: venue "Skyline Beirut" ------------------------------------
INSERT INTO users
  (id, email, phone, password_hash, role, status, account_code,
   email_verified_at, phone_verified_at, created_at)
VALUES
  ('00000000-0000-0000-0000-000000000024',
   'events@skylinebeirut.com', '+9613002005',
   '$2b$12$pVlhy/3vjrYCjSHC47/tmO.RkCyZ7cX3WGp6MUoih2GiQdOuO5p5S',
   'planner', 'active', 'PLN-000005',
   NOW() - INTERVAL '35 days', NOW() - INTERVAL '35 days', NOW() - INTERVAL '35 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO planner_profiles
  (id, user_id, display_name, company_name, bio, location_city, location_country,
   event_types, social_links, thumbnail_url, created_at)
VALUES
  ('20000000-0000-0000-0000-000000000024',
   '00000000-0000-0000-0000-000000000024',
   'Skyline Beirut',
   'Skyline Beirut Rooftop',
   'Rooftop event venue overlooking the Beirut skyline and the Mediterranean. Hosts weddings, corporate launches, and private nightlife events for up to 300 guests. In-house sound, lighting, and bar.',
   'Beirut', 'Lebanon',
   '["Wedding","Corporate","Private Party","Product Launch"]',
   '{"instagram":"https://instagram.com/skylinebeirut","website":"https://skylinebeirut.com"}',
   '/seed/skyline-beirut.png',
   NOW() - INTERVAL '35 days')
ON CONFLICT (id) DO NOTHING;

-- 3) Hide Joe Gemayel (…021) and Maya Hajj (…022) ---------------------------
--    Reversible: SET status='active', deleted_at=NULL to bring them back.
UPDATE users
   SET status = 'banned', deleted_at = NOW()
 WHERE id IN ('00000000-0000-0000-0000-000000000021',
              '00000000-0000-0000-0000-000000000022');
