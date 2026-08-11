-- =============================================================
-- 017: verification_records — the identity-verification audit trail
--
-- One row per verification attempt for an account, holding what was
-- established, how, by whom, and on what evidence.
--
-- WHAT IS AND ISN'T POPULATED TODAY
-- ---------------------------------
-- Fann has no identity-verification provider integrated. Account review is
-- an admin looking at an uploaded document (see id_documents) and deciding.
-- So the columns split in two:
--
--   Captured now — user_id, timestamps, result, ip_address, user_agent,
--   consent_snapshot, audit_log, reviewed_by.
--
--   Provider-only, nullable until one exists — provider, transaction_id,
--   the verified_* attributes, methods, attestation, report_url, and the
--   report hash/signature. These are deliberately present and empty rather
--   than omitted: adding them later would mean a second migration and a
--   gap in the record for every account verified in the meantime.
--
-- Design notes:
--
--  * consent_snapshot is a copy, not a join. user_consents is append-only
--    so a join would show today's consents, not the ones current when the
--    decision was made. Evidence has to be a point-in-time capture.
--
--  * audit_log is an append-only JSONB array of {at, actor, step, detail}.
--    JSONB rather than a child table because the steps are heterogeneous
--    and only ever read whole, alongside the record.
--
--  * result starts 'pending' at signup and is settled by an admin decision
--    or, later, a provider callback. 'manually_approved' is distinct from
--    'passed' on purpose — an admin eyeballing a photo is not the same
--    assurance as a provider attestation, and merging them would overstate
--    what was checked.
--
--  * report_sha256/report_signature exist so a provider report can be shown
--    not to have been altered after the fact. Meaningless without a
--    provider, hence nullable.
--
-- Idempotent: safe to run by hand on an already-seeded DB, and again on a
-- fresh rebuild.
-- =============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verification_result') THEN
    CREATE TYPE verification_result AS ENUM (
      'pending', 'passed', 'failed', 'manually_approved'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS verification_records (
  id                     UUID                PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which account was verified.
  user_id                UUID                NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- The specific verification session at the provider. Null until there is
  -- a provider.
  provider               VARCHAR(50),
  provider_transaction_id VARCHAR(200),

  -- When.
  created_at             TIMESTAMP           NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMP,

  -- Passed, failed, or manually approved.
  result                 verification_result NOT NULL DEFAULT 'pending',

  -- Verified attributes, as reported by a provider. Document number is
  -- stored masked only — the full number is not needed to evidence that a
  -- check happened, and holding it would be a liability.
  verified_name          VARCHAR(200),
  verified_date_of_birth DATE,
  verified_nationality   VARCHAR(100),
  document_type          VARCHAR(50),
  document_number_masked VARCHAR(50),

  -- Which checks were run: document_validation, selfie_comparison,
  -- liveness_check, database_check, manual_review.
  methods                JSONB               NOT NULL DEFAULT '[]',

  -- The provider's statement that the person was verified, and where the
  -- full report lives.
  provider_attestation   TEXT,
  provider_report_url    VARCHAR(500),

  -- Tamper evidence over that report.
  report_sha256          VARCHAR(64),
  report_signature       TEXT,

  -- The device and network the verification was performed from.
  ip_address             VARCHAR(45),
  user_agent             TEXT,

  -- Which terms/privacy versions the user had accepted at this point.
  consent_snapshot       JSONB               NOT NULL DEFAULT '[]',

  -- Steps performed, append-only: {at, actor, step, detail}.
  audit_log              JSONB               NOT NULL DEFAULT '[]',

  -- The admin who settled a manual decision.
  reviewed_by            UUID                REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_verification_records_user_id ON verification_records (user_id);
CREATE INDEX IF NOT EXISTS idx_verification_records_result  ON verification_records (result);
CREATE INDEX IF NOT EXISTS idx_verification_records_created ON verification_records (created_at DESC);

-- Backfill: every existing account gets a record, so the log covers the
-- whole user base rather than starting from today. Their result reflects
-- the status they already have — active accounts were approved by an admin
-- at some point, everyone else is still pending. No IP or user agent is
-- invented for these; those signups predate the capture.
INSERT INTO verification_records (user_id, result, completed_at, methods, audit_log)
SELECT
  u.id,
  CASE WHEN u.status = 'active' THEN 'manually_approved'::verification_result
       ELSE 'pending'::verification_result END,
  CASE WHEN u.status = 'active' THEN u.created_at ELSE NULL END,
  CASE WHEN u.status = 'active' THEN '["manual_review"]'::jsonb ELSE '[]'::jsonb END,
  jsonb_build_array(jsonb_build_object(
    'at', u.created_at,
    'actor', 'system',
    'step', 'backfilled',
    'detail', 'Record created by migration 017 from the account''s existing status; no verification session was run.'
  ))
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM verification_records vr WHERE vr.user_id = u.id
);
