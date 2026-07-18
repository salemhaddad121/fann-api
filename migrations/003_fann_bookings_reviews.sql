-- =============================================================
-- Fann — Bookings & Reviews Migration
-- 003_fann_bookings_reviews.sql
-- Run after 001 and 002.
-- =============================================================

-- =============================================================
-- ENUMS
-- =============================================================

CREATE TYPE booking_status AS ENUM (
  'pending',    -- planner proposed, artist hasn't accepted yet
  'accepted',   -- both parties confirmed
  'declined',   -- artist declined
  'cancelled',  -- either party cancelled after acceptance
  'completed'   -- event date has passed, triggers review flow
);

CREATE TYPE review_role AS ENUM ('artist', 'planner');

-- =============================================================
-- BOOKINGS
-- =============================================================

CREATE TABLE bookings (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id         UUID           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  planner_id        UUID           NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  conversation_id   UUID           REFERENCES conversations (id) ON DELETE SET NULL,
  event_name        VARCHAR(200)   NOT NULL,
  event_date        DATE           NOT NULL,
  event_location    VARCHAR(300),
  duration_hours    NUMERIC(4,1),
  agreed_fee_usd    NUMERIC(10,2),
  notes             TEXT,
  status            booking_status NOT NULL DEFAULT 'pending',
  -- Acceptance tracking
  artist_accepted_at  TIMESTAMP,
  planner_accepted_at TIMESTAMP,
  -- Cancellation
  cancelled_by      UUID           REFERENCES users (id) ON DELETE SET NULL,
  cancelled_at      TIMESTAMP,
  cancellation_note TEXT,
  -- Review flow trigger
  review_emails_sent_at TIMESTAMP,  -- set when the day-after cron fires
  created_at        TIMESTAMP      NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP      NOT NULL DEFAULT NOW(),
  CHECK (event_date >= created_at::DATE)
);

CREATE INDEX idx_bookings_artist_id   ON bookings (artist_id);
CREATE INDEX idx_bookings_planner_id  ON bookings (planner_id);
CREATE INDEX idx_bookings_status      ON bookings (status);
CREATE INDEX idx_bookings_event_date  ON bookings (event_date);

CREATE TRIGGER trg_bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================
-- REVIEWS
-- =============================================================

-- QC dimensions stored as 1-5 integer scores.
-- Both artist-reviewing-planner and planner-reviewing-artist
-- use the same table; `reviewer_role` identifies which direction.

CREATE TABLE reviews (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      UUID         NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  reviewer_id     UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reviewee_id     UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reviewer_role   review_role  NOT NULL,   -- who wrote this review

  -- Overall score (1–5)
  overall_score   SMALLINT     NOT NULL CHECK (overall_score BETWEEN 1 AND 5),

  -- QC dimension scores (1–5)
  score_communication   SMALLINT NOT NULL CHECK (score_communication   BETWEEN 1 AND 5),
  score_professionalism SMALLINT NOT NULL CHECK (score_professionalism BETWEEN 1 AND 5),
  score_punctuality     SMALLINT NOT NULL CHECK (score_punctuality     BETWEEN 1 AND 5),
  -- Artist-specific: quality of performance
  -- Planner-specific: quality of event organisation
  score_quality         SMALLINT NOT NULL CHECK (score_quality         BETWEEN 1 AND 5),

  -- Free-text body (optional but encouraged)
  body            TEXT,

  -- Anonymity mechanic:
  -- is_visible = FALSE until both parties have submitted,
  -- OR 7 days have elapsed since review_emails_sent_at.
  is_visible      BOOLEAN      NOT NULL DEFAULT FALSE,

  submitted_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (booking_id, reviewer_id)  -- one review per person per booking
);

CREATE INDEX idx_reviews_booking_id   ON reviews (booking_id);
CREATE INDEX idx_reviews_reviewee_id  ON reviews (reviewee_id);
CREATE INDEX idx_reviews_is_visible   ON reviews (reviewee_id, is_visible);

-- =============================================================
-- AGGREGATE RATING COLUMNS ON PROFILES
-- Denormalised for fast reads. Updated every time a review
-- is made visible by reviews.service.ts.
-- =============================================================

ALTER TABLE artist_profiles
  ADD COLUMN avg_rating    NUMERIC(3,2) DEFAULT NULL,
  ADD COLUMN review_count  INT          NOT NULL DEFAULT 0;

ALTER TABLE planner_profiles
  ADD COLUMN avg_rating    NUMERIC(3,2) DEFAULT NULL,
  ADD COLUMN review_count  INT          NOT NULL DEFAULT 0;

-- =============================================================
-- NOTIFICATIONS TABLE
-- Lightweight in-app notifications (email is handled by the
-- scheduler via the email provider). Expandable for push later.
-- =============================================================

CREATE TABLE notifications (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type        VARCHAR(60) NOT NULL,  -- e.g. 'booking_request', 'review_request', 'review_published'
  title       VARCHAR(200) NOT NULL,
  body        TEXT,
  data        JSONB     NOT NULL DEFAULT '{}',  -- e.g. { booking_id, review_id }
  read_at     TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_id ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_unread  ON notifications (user_id) WHERE read_at IS NULL;

-- =============================================================
-- AUDIT LOG — extend enum with new actions
-- =============================================================

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'booking.accepted';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'booking.declined';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'booking.cancelled';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'review.removed';

-- =============================================================
-- END OF MIGRATION
-- =============================================================
