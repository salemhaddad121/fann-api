-- =============================================================
-- 016: user_consents — what each user agreed to, and when
--
-- Signup previously recorded no agreement at all: there was no terms
-- checkbox, no privacy notice, and nothing in the schema to hold either.
--
-- Design notes:
--
--  * One row per document per acceptance, not a boolean on `users`. A
--    boolean answers "did they agree?" but not "to what?", which is the
--    only question that matters once the wording changes. Keeping rows
--    means a revised document is a new row, and the old acceptance stays
--    intact as evidence of what was true at the time.
--
--  * `version` is a plain string set by the API (see CONSENT_VERSIONS in
--    src/consent/consent.constants.ts) rather than a foreign key to a
--    documents table. There is no document management here yet — the text
--    lives in the frontend — so a version label is the honest amount of
--    structure. It's indexed so "who is still on the old terms?" stays a
--    cheap query when that matters.
--
--  * ip_address and user_agent are captured because an acceptance without
--    them is weak evidence. They also feed the consent row of the
--    verification record added in 017.
--
--  * No UNIQUE on (user_id, document): re-accepting a new version must be
--    allowed to append. Read the latest by accepted_at.
--
-- Idempotent: safe to run by hand on an already-seeded DB, and again on a
-- fresh rebuild.
-- =============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'consent_document') THEN
    CREATE TYPE consent_document AS ENUM ('terms', 'privacy');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_consents (
  id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID             NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  document    consent_document NOT NULL,
  version     VARCHAR(50)      NOT NULL,
  accepted_at TIMESTAMP        NOT NULL DEFAULT NOW(),
  -- Nullable: a consent recorded outside a request (a backfill, an admin
  -- action) legitimately has no client address attached, and a blank
  -- string would read as though we captured one.
  ip_address  VARCHAR(45),
  user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_consents_user_id  ON user_consents (user_id);
CREATE INDEX IF NOT EXISTS idx_user_consents_document ON user_consents (document, version);
