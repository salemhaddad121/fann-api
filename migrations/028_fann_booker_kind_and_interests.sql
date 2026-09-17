-- =============================================================
-- 028: individual vs company bookers, and what they came for
--
-- The $5 day pass opened the platform to one-off individual bookers — a
-- couple planning a wedding, a parent booking animators. The platform was
-- designed when every booker was a business, and nothing in the schema can
-- tell the two apart. Everything downstream depends on that distinction:
-- who may find whom (028 + C5), what admin sees, and what the advertising
-- product can ever target.
--
-- NUMBERING: the specification calls this 025. That number, and 026 and
-- 027, were taken by the pre-launch audit work (profile rows at signup,
-- case-insensitive email, the audit_action enum value). Renumbered rather
-- than renamed, because 025-027 are already applied to databases and
-- editing an applied migration changes nothing in them.
-- =============================================================

-- ------------------------------------------------------------
-- 1. Individual vs company.
--
-- Nullable on purpose. Existing bookers predate the question and are
-- prompted on next login rather than locked out (Q3) — a hard NOT NULL
-- here would break every account created before today.
-- ------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'planner_kind') THEN
    CREATE TYPE planner_kind AS ENUM ('individual', 'company');
  END IF;
END $$;

ALTER TABLE planner_profiles
  ADD COLUMN IF NOT EXISTS planner_kind planner_kind;

-- Used by the C5 directory filter, which selects companies only.
CREATE INDEX IF NOT EXISTS idx_planner_profiles_kind
  ON planner_profiles (planner_kind);


-- ------------------------------------------------------------
-- 2. A booker-facing bucket on categories.
--
-- Deliberately NOT the same axis as category_groups. Artists classify by
-- craft and bookers search by need, and the two genuinely differ: a DJ is a
-- musician to himself and a service to a venue. Keeping them as separate
-- columns means DJ stays in the Music group for artists while answering
-- "DJs & Services" for bookers — no row moves, no slug changes, no SEO
-- impact. That is the entire reason this is a second column and not a
-- regrouping.
-- ------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'booker_interest') THEN
    CREATE TYPE booker_interest AS ENUM (
      'musical_acts', 'performance_acts', 'photo_video', 'djs_and_services'
    );
  END IF;
END $$;

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS booker_interest booker_interest;


-- ------------------------------------------------------------
-- 3. Map every category to a bucket.
--
-- TWO CORRECTIONS to the specification's mapping, both found by reading the
-- live catalogue rather than the spec:
--
--   * It states "Bartender does not exist as a category at all" and adds an
--     INSERT for 'bartender-bar-service'. Both 'bartender' and
--     'bar-services' already exist, in the food-beverage group. Running
--     that INSERT would have produced a THIRD bartender category and split
--     bookings across it. The INSERT is dropped and the existing rows are
--     mapped instead.
--
--   * Its mapping covers 36 of the 39 categories. The whole food-beverage
--     group — catering, bartender, bar-services — is unassigned, so its own
--     acceptance test (no category left NULL) could not have passed. All
--     three are mapped here, into djs_and_services: the bucket is labelled
--     "DJs, Bartenders & Event Services" on the signup form, which is
--     exactly what they are.
--
-- 'saxophonist' is also in the spec's list and in no database; it is
-- dropped from the IN clause rather than left as a silent no-op.
-- ------------------------------------------------------------

UPDATE categories SET booker_interest = 'musical_acts'
  WHERE slug IN ('singer-vocalist','band-group','oud-player','dabke-group','choir',
                 'jazz-musician','classical-musician','pianist');

UPDATE categories SET booker_interest = 'performance_acts'
  WHERE slug IN ('mc-host','stand-up-comedian','magician','caricaturist','face-painter',
                 'balloon-artist','fire-performer','acrobat-circus-act','dancer-dance-group',
                 'belly-dancer','folkloric-performer','childrens-entertainer',
                 'hype-man-energizer','live-painter','calligrapher');

UPDATE categories SET booker_interest = 'photo_video'
  WHERE slug IN ('photographer','videographer','photo-booth','360-video-booth',
                 'drone-operator','roaming-photographer');

UPDATE categories SET booker_interest = 'djs_and_services'
  WHERE slug IN ('dj','bartender','bar-services','catering','sound-lighting',
                 'led-screen-av-setup','stage-decoration','pyrotechnics');

-- Anything the four lists missed, including 'other'. Belt to the braces
-- above, so a category added between the audit and this migration still
-- lands somewhere rather than becoming invisible to every booker.
UPDATE categories SET booker_interest = 'djs_and_services'
  WHERE booker_interest IS NULL;


-- ------------------------------------------------------------
-- 4. What the booker said they were looking for.
--
-- A table rather than an array column: the question is multi-select (Q1),
-- and "how many bookers want photo & video" is a question the advertising
-- product will ask on day one. An index on the interest is what makes that
-- a scan of one column rather than of every profile's JSON.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS planner_interests (
  planner_profile_id UUID            NOT NULL REFERENCES planner_profiles (id) ON DELETE CASCADE,
  interest           booker_interest NOT NULL,
  created_at         TIMESTAMP       NOT NULL DEFAULT NOW(),
  PRIMARY KEY (planner_profile_id, interest)
);

CREATE INDEX IF NOT EXISTS idx_planner_interests_interest
  ON planner_interests (interest);


-- ------------------------------------------------------------
-- 5. The specification's own acceptance test, enforced here rather than
--    left to be run by hand later.
--
--    Point-in-time, not a constraint: migration 029 adds the Venue category
--    with booker_interest deliberately NULL, because a booker looking for
--    talent should not be offered rooms.
-- ------------------------------------------------------------
DO $$
DECLARE
  unmapped integer;
BEGIN
  SELECT count(*) INTO unmapped FROM categories WHERE booker_interest IS NULL;
  IF unmapped > 0 THEN
    RAISE EXCEPTION '% categor(y/ies) have no booker_interest bucket', unmapped;
  END IF;
END $$;
