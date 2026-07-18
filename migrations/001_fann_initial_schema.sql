-- =============================================================
-- Fann — Initial Schema Migration
-- 001_fann_initial_schema.sql
-- PostgreSQL 15+
-- Run with: psql -U <user> -d <db> -f 001_fann_initial_schema.sql
-- =============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- =============================================================
-- ENUMS
-- =============================================================

CREATE TYPE user_role       AS ENUM ('artist', 'planner', 'admin');
CREATE TYPE user_status     AS ENUM ('pending_review', 'active', 'suspended', 'banned');
CREATE TYPE media_type      AS ENUM ('photo', 'video');
CREATE TYPE doc_status      AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE payment_service AS ENUM ('OMT', 'Wish', 'WesternUnion', 'other');
CREATE TYPE payment_status  AS ENUM ('pending', 'confirmed', 'rejected', 'expired');
CREATE TYPE flag_target     AS ENUM ('profile', 'message', 'conversation');
CREATE TYPE flag_status     AS ENUM ('open', 'dismissed', 'actioned');
CREATE TYPE audit_action    AS ENUM (
  'user.approved', 'user.rejected', 'user.suspended', 'user.banned',
  'id_doc.approved', 'id_doc.rejected',
  'payment.confirmed', 'payment.rejected',
  'flag.dismissed', 'flag.actioned'
);


-- =============================================================
-- CORE ENTITIES
-- =============================================================

-- ------------------------------------------------------------
-- users
-- Single table for all roles. Role determines which profile
-- table the record connects to.
-- ------------------------------------------------------------
CREATE TABLE users (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  email               VARCHAR(255)  NOT NULL UNIQUE,
  phone               VARCHAR(20),
  password_hash       VARCHAR(255),                         -- NULL if social-only login
  role                user_role     NOT NULL,
  status              user_status   NOT NULL DEFAULT 'pending_review',
  account_code        VARCHAR(20)   NOT NULL UNIQUE,        -- e.g. ART-000001, PLN-000042
  email_verified_at   TIMESTAMP,
  phone_verified_at   TIMESTAMP,
  last_login_at       TIMESTAMP,
  created_at          TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email       ON users (email);
CREATE INDEX idx_users_role        ON users (role);
CREATE INDEX idx_users_status      ON users (status);
CREATE INDEX idx_users_account_code ON users (account_code);

-- Auto-update updated_at on every write
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- oauth_accounts
-- Links a user to a social login provider (Google, Apple).
-- ------------------------------------------------------------
CREATE TABLE oauth_accounts (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider     VARCHAR(50)  NOT NULL,                       -- 'google' | 'apple'
  provider_uid VARCHAR(255) NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_uid)
);

CREATE INDEX idx_oauth_user_id ON oauth_accounts (user_id);


-- ------------------------------------------------------------
-- categories
-- Master list of artist categories (DJ, Band, Photographer…)
-- ------------------------------------------------------------
CREATE TABLE categories (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(100) NOT NULL UNIQUE,
  slug       VARCHAR(100) NOT NULL UNIQUE,
  sort_order INT          NOT NULL DEFAULT 0,
  created_at TIMESTAMP    NOT NULL DEFAULT NOW()
);


-- ------------------------------------------------------------
-- artist_profiles
-- One row per artist user.
-- ------------------------------------------------------------
CREATE TABLE artist_profiles (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID          NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  category_id      UUID          REFERENCES categories (id) ON DELETE SET NULL,
  display_name     VARCHAR(150)  NOT NULL,
  bio              TEXT,
  location_city    VARCHAR(100),
  location_country VARCHAR(100),
  base_price_usd   NUMERIC(10,2),                           -- indicative starting price
  languages        JSONB         NOT NULL DEFAULT '[]',     -- ["Arabic","English","French"]
  social_links     JSONB         NOT NULL DEFAULT '{}',     -- {"instagram":"...","tiktok":"..."}
  is_verified      BOOLEAN       NOT NULL DEFAULT FALSE,    -- admin toggles after ID approval
  thumbnail_url    VARCHAR(500),                            -- CDN URL of primary photo
  created_at       TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_artist_profiles_user_id     ON artist_profiles (user_id);
CREATE INDEX idx_artist_profiles_category_id ON artist_profiles (category_id);
CREATE INDEX idx_artist_profiles_location    ON artist_profiles (location_country, location_city);
CREATE INDEX idx_artist_profiles_verified    ON artist_profiles (is_verified);

CREATE TRIGGER trg_artist_profiles_updated_at
  BEFORE UPDATE ON artist_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- planner_profiles
-- One row per planner user.
-- ------------------------------------------------------------
CREATE TABLE planner_profiles (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID         NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  display_name     VARCHAR(150) NOT NULL,
  company_name     VARCHAR(150),
  bio              TEXT,
  location_city    VARCHAR(100),
  location_country VARCHAR(100),
  event_types      JSONB        NOT NULL DEFAULT '[]',      -- ["Wedding","Corporate","Festival"]
  social_links     JSONB        NOT NULL DEFAULT '{}',
  thumbnail_url    VARCHAR(500),
  created_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_planner_profiles_user_id ON planner_profiles (user_id);

CREATE TRIGGER trg_planner_profiles_updated_at
  BEFORE UPDATE ON planner_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- media
-- Photos and videos uploaded by artists or planners.
-- S3 object key is stored; CDN URL is derived at serve-time.
-- ------------------------------------------------------------
CREATE TABLE media (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  media_type      media_type   NOT NULL,
  s3_key          VARCHAR(500) NOT NULL,
  cdn_url         VARCHAR(500),                              -- set after upload confirms
  file_size_bytes BIGINT       NOT NULL CHECK (
    (media_type = 'photo' AND file_size_bytes <= 10485760)   -- photos: max 10 MB
    OR
    (media_type = 'video' AND file_size_bytes <= 262144000)  -- videos: max 250 MB
  ),
  duration_sec    INT          CHECK (
    (media_type = 'photo') OR
    (media_type = 'video' AND duration_sec <= 60)            -- videos: max 60 s
  ),
  is_primary      BOOLEAN      NOT NULL DEFAULT FALSE,
  sort_order      INT          NOT NULL DEFAULT 0,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_media_user_id    ON media (user_id);
CREATE INDEX idx_media_is_primary ON media (user_id, is_primary);

-- Ensure only one primary media item per user
CREATE UNIQUE INDEX idx_media_one_primary
  ON media (user_id)
  WHERE is_primary = TRUE;


-- ------------------------------------------------------------
-- id_documents
-- Identity verification uploads. S3 key only — signed URLs
-- are generated on-demand and expire in 15 minutes.
-- ------------------------------------------------------------
CREATE TABLE id_documents (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  s3_key           VARCHAR(500) NOT NULL,
  status           doc_status  NOT NULL DEFAULT 'pending',
  rejection_reason TEXT,
  reviewed_by      UUID        REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at      TIMESTAMP,
  uploaded_at      TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_id_documents_user_id ON id_documents (user_id);
CREATE INDEX idx_id_documents_status  ON id_documents (status);


-- ------------------------------------------------------------
-- availability_blocks
-- Date ranges an artist marks as unavailable.
-- ------------------------------------------------------------
CREATE TABLE availability_blocks (
  id         UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id  UUID      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  start_date DATE      NOT NULL,
  end_date   DATE      NOT NULL,
  note       TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CHECK (end_date >= start_date)
);

CREATE INDEX idx_availability_artist_id ON availability_blocks (artist_id);
CREATE INDEX idx_availability_dates     ON availability_blocks (artist_id, start_date, end_date);


-- =============================================================
-- INTERACTIONS
-- =============================================================

-- ------------------------------------------------------------
-- conversations
-- Each pair of artist + planner has at most one conversation.
-- ------------------------------------------------------------
CREATE TABLE conversations (
  id              UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  artist_id       UUID      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  planner_id      UUID      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_message_at TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (artist_id, planner_id)
);

CREATE INDEX idx_conversations_artist_id  ON conversations (artist_id);
CREATE INDEX idx_conversations_planner_id ON conversations (planner_id);
CREATE INDEX idx_conversations_last_msg   ON conversations (last_message_at DESC);


-- ------------------------------------------------------------
-- messages
-- ------------------------------------------------------------
CREATE TABLE messages (
  id              UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID      NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_id       UUID      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body            TEXT      NOT NULL,
  read_at         TIMESTAMP,                                -- NULL = unread
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation_id ON messages (conversation_id, created_at);
CREATE INDEX idx_messages_sender_id       ON messages (sender_id);
CREATE INDEX idx_messages_unread          ON messages (conversation_id) WHERE read_at IS NULL;


-- ------------------------------------------------------------
-- payments
-- Planner subscription payments via local transfer services.
-- ------------------------------------------------------------
CREATE TABLE payments (
  id               UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  planner_id       UUID            NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount_usd       NUMERIC(10,2)   NOT NULL,
  transfer_service payment_service NOT NULL,
  reference_code   VARCHAR(100),                           -- transfer reference given by planner
  period_start     DATE            NOT NULL,
  period_end       DATE            NOT NULL,
  status           payment_status  NOT NULL DEFAULT 'pending',
  confirmed_by     UUID            REFERENCES users (id) ON DELETE SET NULL,
  confirmed_at     TIMESTAMP,
  rejection_reason TEXT,
  created_at       TIMESTAMP       NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP       NOT NULL DEFAULT NOW(),
  CHECK (period_end > period_start)
);

CREATE INDEX idx_payments_planner_id ON payments (planner_id);
CREATE INDEX idx_payments_status     ON payments (status);

CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =============================================================
-- ADMIN
-- =============================================================

-- ------------------------------------------------------------
-- flags
-- Users can flag a profile or a message thread.
-- Admins resolve via the flags queue.
-- ------------------------------------------------------------
CREATE TABLE flags (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  flagged_by    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_type   flag_target NOT NULL,
  target_id     UUID        NOT NULL,                      -- profile user_id or message_id
  reason        TEXT        NOT NULL,
  status        flag_status NOT NULL DEFAULT 'open',
  resolved_by   UUID        REFERENCES users (id) ON DELETE SET NULL,
  resolved_at   TIMESTAMP,
  resolver_note TEXT,
  created_at    TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_flags_status     ON flags (status);
CREATE INDEX idx_flags_target     ON flags (target_type, target_id);
CREATE INDEX idx_flags_flagged_by ON flags (flagged_by);


-- ------------------------------------------------------------
-- audit_log
-- Immutable log of every admin action. Never update or delete.
-- ------------------------------------------------------------
CREATE TABLE audit_log (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id    UUID         NOT NULL REFERENCES users (id) ON DELETE SET NULL,
  action      audit_action NOT NULL,
  target_id   UUID         NOT NULL,                       -- the user/doc/payment acted on
  note        TEXT,
  metadata    JSONB        NOT NULL DEFAULT '{}',           -- extra context, rejection reasons, etc.
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_admin_id  ON audit_log (admin_id);
CREATE INDEX idx_audit_log_target_id ON audit_log (target_id);
CREATE INDEX idx_audit_log_action    ON audit_log (action);
CREATE INDEX idx_audit_log_created   ON audit_log (created_at DESC);


-- =============================================================
-- SEED: default categories
-- =============================================================

INSERT INTO categories (name, slug, sort_order) VALUES
  ('DJ',              'dj',              1),
  ('Live Band',       'live-band',       2),
  ('Solo Artist',     'solo-artist',     3),
  ('Photographer',    'photographer',    4),
  ('Videographer',    'videographer',    5),
  ('Comedian',        'comedian',        6),
  ('Dancer',          'dancer',          7),
  ('Magician',        'magician',        8),
  ('MC / Host',       'mc-host',         9),
  ('Caricaturist',    'caricaturist',   10),
  ('Face Painter',    'face-painter',   11),
  ('Florist',         'florist',        12),
  ('Photo Booth',     'photo-booth',    13),
  ('Lighting & AV',  'lighting-av',    14),
  ('Other',           'other',          99);


-- =============================================================
-- END OF MIGRATION
-- =============================================================
