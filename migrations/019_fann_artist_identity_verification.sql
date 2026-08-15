-- =============================================================
-- 019: artist identity verification — ID document + selfie
--
-- Artists must pass identity verification before their account goes live.
-- Bookers are deliberately NOT gated: the day pass explicitly skips ID
-- (subscription_plans.requires_id_doc = false), and the two sides of the
-- marketplace are not the same risk.
--
-- What was already here, and why this file is small:
--
--  * users.status starts at 'pending_review' for everyone, and every
--    public artist query filters on u.status = 'active'. So a listing gate
--    ALREADY exists — an admin activating the account is what publishes
--    it. What was missing is anything forcing that decision to be based on
--    documents, which is enforcement in code, not schema.
--
--  * id_documents already holds the review lifecycle (status, reviewer,
--    rejection reason) and stores an s3_key rather than a URL, because
--    these must never be served from the public CDN the way profile media
--    is. That distinction is load-bearing and is kept.
--
-- So the only schema change needed is room for a SECOND document per user.
-- id_documents had UNIQUE (user_id), which allows exactly one — fine when
-- an ID was the only artefact, wrong once a selfie is required alongside
-- it.
--
-- A `kind` column plus UNIQUE (user_id, kind) is preferred over a separate
-- selfies table: the review lifecycle, the admin queue, the presign flow
-- and the audit trail are identical for both, and splitting them would
-- mean maintaining two of everything to store one extra file.
--
-- Existing rows are ID documents by definition — the selfie did not exist
-- when they were written — so the default backfills them correctly.
--
-- Idempotent: guarded throughout. Safe to re-run.
-- =============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'id_document_kind') THEN
    CREATE TYPE id_document_kind AS ENUM ('id_document', 'selfie');
  END IF;
END $$;

ALTER TABLE id_documents
  ADD COLUMN IF NOT EXISTS kind id_document_kind NOT NULL DEFAULT 'id_document';

-- Swap the single-document constraint for one document of each kind.
-- Dropped by name: 001 created it implicitly via UNIQUE on the column, and
-- Postgres names that <table>_<column>_key.
ALTER TABLE id_documents DROP CONSTRAINT IF EXISTS id_documents_user_id_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'id_documents_user_id_kind_key'
  ) THEN
    ALTER TABLE id_documents
      ADD CONSTRAINT id_documents_user_id_kind_key UNIQUE (user_id, kind);
  END IF;
END $$;

-- The admin queue reads pending documents oldest-first across both kinds.
CREATE INDEX IF NOT EXISTS idx_id_documents_status_kind
  ON id_documents (status, kind, uploaded_at);
