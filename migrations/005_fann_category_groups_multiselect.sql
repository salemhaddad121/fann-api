-- =============================================================
-- 005 — Multi-select, grouped categories
--
-- Replaces the single-FK `artist_profiles.category_id` model with:
--   category_groups (Music, Visual, Performance & Entertainment,
--                     Production & Technical, Speciality, Other)
--   categories       (now belongs to a group)
--   artist_categories (join table — an artist may pick up to 4)
--
-- This matches the approved onboarding UI (grouped picker, max 4).
-- =============================================================

-- ------------------------------------------------------------
-- category_groups
-- ------------------------------------------------------------
CREATE TABLE category_groups (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(100) NOT NULL UNIQUE,
  slug       VARCHAR(100) NOT NULL UNIQUE,
  icon       VARCHAR(50),                                    -- e.g. "ti-music" (Tabler Icons class used in the mockups)
  sort_order INT          NOT NULL DEFAULT 0,
  created_at TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- categories — add group_id (nullable during migration, enforced after backfill)
-- ------------------------------------------------------------
ALTER TABLE categories ADD COLUMN group_id UUID REFERENCES category_groups (id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- artist_categories — many-to-many, up to 4 per artist
-- ------------------------------------------------------------
CREATE TABLE artist_categories (
  artist_profile_id UUID NOT NULL REFERENCES artist_profiles (id) ON DELETE CASCADE,
  category_id       UUID NOT NULL REFERENCES categories (id)       ON DELETE CASCADE,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artist_profile_id, category_id)
);

CREATE INDEX idx_artist_categories_artist   ON artist_categories (artist_profile_id);
CREATE INDEX idx_artist_categories_category ON artist_categories (category_id);

-- Enforce max 4 categories per artist at the DB level too (app-level
-- validation is the primary guard via CreateArtistProfileDto, this is
-- defense-in-depth for any direct DB writes, e.g. admin tooling).
CREATE OR REPLACE FUNCTION enforce_max_categories_per_artist()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM artist_categories WHERE artist_profile_id = NEW.artist_profile_id) >= 4 THEN
    RAISE EXCEPTION 'An artist profile can have at most 4 categories.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_max_categories
BEFORE INSERT ON artist_categories
FOR EACH ROW EXECUTE FUNCTION enforce_max_categories_per_artist();

-- ------------------------------------------------------------
-- Backfill: migrate any existing single-category assignments into
-- the join table before dropping the old column. Safe no-op if
-- the table is empty (fresh dev DB).
-- ------------------------------------------------------------
INSERT INTO artist_categories (artist_profile_id, category_id)
SELECT id, category_id FROM artist_profiles WHERE category_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Drop the old single-FK column + its index
-- ------------------------------------------------------------
DROP INDEX IF EXISTS idx_artist_profiles_category_id;
ALTER TABLE artist_profiles DROP COLUMN category_id;

-- ------------------------------------------------------------
-- Reseed: clear the old flat 15-category list, insert the
-- approved grouped 36-category list (6 groups).
-- Safe because artist_categories is brand new / empty at this point.
-- ------------------------------------------------------------
DELETE FROM categories;

INSERT INTO category_groups (name, slug, icon, sort_order) VALUES
  ('Music',                       'music',                    'ti-music',                      1),
  ('Visual',                      'visual',                   'ti-camera',                     2),
  ('Performance & Entertainment', 'performance-entertainment', 'ti-masks-theater',              3),
  ('Production & Technical',      'production-technical',      'ti-device-speaker',             4),
  ('Speciality',                  'speciality',                'ti-star',                       5),
  ('Other',                       'other',                     'ti-dots-circle-horizontal',     6);

-- Music
INSERT INTO categories (name, slug, sort_order, group_id) VALUES
  ('DJ',                  'dj',                  1,  (SELECT id FROM category_groups WHERE slug = 'music')),
  ('Singer / Vocalist',   'singer-vocalist',     2,  (SELECT id FROM category_groups WHERE slug = 'music')),
  ('Band / Group',        'band-group',          3,  (SELECT id FROM category_groups WHERE slug = 'music')),
  ('Oud Player',          'oud-player',          4,  (SELECT id FROM category_groups WHERE slug = 'music')),
  ('Dabke Group',         'dabke-group',         5,  (SELECT id FROM category_groups WHERE slug = 'music')),
  ('Choir',               'choir',               6,  (SELECT id FROM category_groups WHERE slug = 'music')),
  ('Jazz Musician',       'jazz-musician',       7,  (SELECT id FROM category_groups WHERE slug = 'music')),
  ('Classical Musician',  'classical-musician',  8,  (SELECT id FROM category_groups WHERE slug = 'music')),
  ('Saxophonist',         'saxophonist',         9,  (SELECT id FROM category_groups WHERE slug = 'music')),
  ('Pianist',             'pianist',             10, (SELECT id FROM category_groups WHERE slug = 'music'));

-- Visual
INSERT INTO categories (name, slug, sort_order, group_id) VALUES
  ('Photographer',        'photographer',        1, (SELECT id FROM category_groups WHERE slug = 'visual')),
  ('Videographer',        'videographer',        2, (SELECT id FROM category_groups WHERE slug = 'visual')),
  ('Photo Booth',         'photo-booth',         3, (SELECT id FROM category_groups WHERE slug = 'visual')),
  ('360 Video Booth',     '360-video-booth',     4, (SELECT id FROM category_groups WHERE slug = 'visual')),
  ('Drone Operator',      'drone-operator',      5, (SELECT id FROM category_groups WHERE slug = 'visual'));

-- Performance & Entertainment
INSERT INTO categories (name, slug, sort_order, group_id) VALUES
  ('MC / Host',              'mc-host',              1,  (SELECT id FROM category_groups WHERE slug = 'performance-entertainment')),
  ('Stand-up Comedian',      'stand-up-comedian',    2,  (SELECT id FROM category_groups WHERE slug = 'performance-entertainment')),
  ('Magician',               'magician',             3,  (SELECT id FROM category_groups WHERE slug = 'performance-entertainment')),
  ('Caricaturist',           'caricaturist',         4,  (SELECT id FROM category_groups WHERE slug = 'performance-entertainment')),
  ('Face Painter',           'face-painter',         5,  (SELECT id FROM category_groups WHERE slug = 'performance-entertainment')),
  ('Balloon Artist',         'balloon-artist',       6,  (SELECT id FROM category_groups WHERE slug = 'performance-entertainment')),
  ('Fire Performer',         'fire-performer',       7,  (SELECT id FROM category_groups WHERE slug = 'performance-entertainment')),
  ('Acrobat / Circus Act',   'acrobat-circus-act',   8,  (SELECT id FROM category_groups WHERE slug = 'performance-entertainment')),
  ('Dancer / Dance Group',   'dancer-dance-group',   9,  (SELECT id FROM category_groups WHERE slug = 'performance-entertainment')),
  ('Belly Dancer',           'belly-dancer',         10, (SELECT id FROM category_groups WHERE slug = 'performance-entertainment')),
  ('Folkloric Performer',    'folkloric-performer',  11, (SELECT id FROM category_groups WHERE slug = 'performance-entertainment'));

-- Production & Technical
INSERT INTO categories (name, slug, sort_order, group_id) VALUES
  ('Sound & Lighting',      'sound-lighting',      1, (SELECT id FROM category_groups WHERE slug = 'production-technical')),
  ('LED Screen / AV Setup', 'led-screen-av-setup', 2, (SELECT id FROM category_groups WHERE slug = 'production-technical')),
  ('Stage Decoration',      'stage-decoration',    3, (SELECT id FROM category_groups WHERE slug = 'production-technical')),
  ('Pyrotechnics',          'pyrotechnics',        4, (SELECT id FROM category_groups WHERE slug = 'production-technical'));

-- Speciality
INSERT INTO categories (name, slug, sort_order, group_id) VALUES
  ('Hype Man / Energizer',   'hype-man-energizer',   1, (SELECT id FROM category_groups WHERE slug = 'speciality')),
  ('Live Painter',           'live-painter',         2, (SELECT id FROM category_groups WHERE slug = 'speciality')),
  ('Calligrapher',           'calligrapher',         3, (SELECT id FROM category_groups WHERE slug = 'speciality')),
  ('Roaming Photographer',   'roaming-photographer', 4, (SELECT id FROM category_groups WHERE slug = 'speciality')),
  ('Children''s Entertainer','childrens-entertainer',5, (SELECT id FROM category_groups WHERE slug = 'speciality'));

-- Other
INSERT INTO categories (name, slug, sort_order, group_id) VALUES
  ('Other — admin will reclassify', 'other', 1, (SELECT id FROM category_groups WHERE slug = 'other'));

-- Now that every row has a group, enforce it going forward.
ALTER TABLE categories ALTER COLUMN group_id SET NOT NULL;

-- ------------------------------------------------------------
-- Audit log — new action types for group management
-- ------------------------------------------------------------
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'category_group.created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'category_group.updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'category_group.deleted';
