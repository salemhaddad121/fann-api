-- =============================================================
-- Fann — Saved Artists Migration
-- 006_fann_saved_artists.sql
-- Run after 001-005.
--
-- Backs the planner-side "Saved" bottom-nav tab, which previously had
-- no table at all — planners could not bookmark an artist anywhere.
-- =============================================================

CREATE TABLE saved_artists (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  planner_id         UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  artist_profile_id  UUID         NOT NULL REFERENCES artist_profiles (id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

  UNIQUE (planner_id, artist_profile_id)
);

CREATE INDEX idx_saved_artists_planner ON saved_artists (planner_id);
