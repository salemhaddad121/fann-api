-- =============================================================
-- 029: Venue as an artist-side category
--
-- In the Lebanese market most venues lease their space to artists rather
-- than producing their own events, so a venue belongs on the supply side:
-- one profile, listed like any artist, visible to planners with no special
-- casing (D2). A venue that also wants to SEARCH for artists registers a
-- separate, billable planner account (D5).
--
-- Renumbered from the spec's 026 — see 028 for why.
-- =============================================================

-- A group of its own, sorted first, so "Venue" sits at the top of the
-- picker. The picker orders by category_groups.sort_order — confirmed in
-- artists.service.ts getCategories().
--
-- sort_order -1, NOT 0 as the specification says. Food & Beverage is
-- already 0, so a second group at 0 leaves the two tied and the order
-- between them undefined — "Venue appears first in the picker" would then
-- be true or false depending on what the planner felt like returning.
-- Negative keeps it unambiguous without renumbering the other seven
-- groups, which is what the spec was trying to avoid.
INSERT INTO category_groups (name, slug, icon, sort_order)
SELECT 'Venues & Spaces', 'venues-spaces', 'ti-building-store', -1
WHERE NOT EXISTS (SELECT 1 FROM category_groups WHERE slug = 'venues-spaces');

-- Unconditional, so re-running this migration corrects a group inserted
-- at the wrong order rather than silently leaving it. The INSERT above is
-- guarded and would not.
UPDATE category_groups SET sort_order = -1 WHERE slug = 'venues-spaces';

-- booker_interest is deliberately NULL, and this is the one category in
-- the catalogue for which that is correct: a booker looking for talent
-- should not be offered rooms. Migration 028's "no category left NULL"
-- assertion was a point-in-time check for exactly this reason. Surfacing
-- venues to bookers as well would be a fifth bucket and a separate
-- decision, not a change to this line.
INSERT INTO categories (name, slug, sort_order, group_id, booker_interest)
SELECT 'Venue', 'venue', 1,
       (SELECT id FROM category_groups WHERE slug = 'venues-spaces'), NULL
WHERE NOT EXISTS (SELECT 1 FROM categories WHERE slug = 'venue');


-- ------------------------------------------------------------
-- Two consequences worth recording here rather than discovering later.
--
-- PRICE. artist_profiles.base_price_usd drives the price filter and the
-- guest price banding ("$250–$500"). A venue's number is a hire fee, not a
-- performance fee, and the two are not comparable. Nothing in this
-- migration changes that; it is flagged in the spec as a decision to take
-- before venues are advertised on price.
--
-- THE FOUR-CATEGORY CAP. enforce_max_categories_per_artist (migration 005)
-- counts Venue like any other category, so a venue that is also a bar with
-- a resident DJ has three of its four slots spent. Judged acceptable, and
-- noted so that a venue complaining about the limit is understood rather
-- than treated as a bug.
-- ------------------------------------------------------------

DO $$
DECLARE
  bucket text;
BEGIN
  SELECT booker_interest::text INTO bucket FROM categories WHERE slug = 'venue';
  IF bucket IS NOT NULL THEN
    RAISE EXCEPTION 'venue must have a NULL booker_interest, found %', bucket;
  END IF;
END $$;

-- And prove the ordering claim rather than asserting it in a comment.
DO $$
DECLARE
  first_group text;
BEGIN
  SELECT slug INTO first_group
    FROM category_groups
   ORDER BY sort_order, name
   LIMIT 1;

  IF first_group IS DISTINCT FROM 'venues-spaces' THEN
    RAISE EXCEPTION 'Venues & Spaces must sort first, found %', first_group;
  END IF;
END $$;
