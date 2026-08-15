-- =============================================================
-- 020: identity document retention
--
-- Fann now stores passport scans and selfies. Nothing ever deleted them,
-- which makes an indefinitely growing pile of government ID the single
-- largest liability in the system — and one with no product value once the
-- verification decision has been made.
--
-- The distinction this migration exists to support:
--
--   the FILE is the liability      -> delete it on a schedule
--   the DECISION is the audit trail -> keep it forever
--
-- So nothing here deletes rows. id_documents keeps status, rejection
-- reason, reviewer and timestamps permanently, which is what answers "was
-- this artist verified, by whom, when?" long after the scan is gone.
-- Only s3_key is cleared, and the object behind it removed from R2.
--
-- purged_at exists to tell two states apart that both leave s3_key NULL:
--
--   never uploaded  -> s3_key NULL, purged_at NULL
--   uploaded, since deleted -> s3_key NULL, purged_at set
--
-- Without it a purged document is indistinguishable from one that was
-- never submitted, and the checklist an artist sees would tell them to
-- upload something they already did.
--
-- Idempotent: guarded throughout.
-- =============================================================

ALTER TABLE id_documents
  ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;

-- s3_key must be nullable for any of the above to work. 001 declared it
-- NOT NULL, which was right when a row could only exist because a file
-- did — and is wrong the moment a row is meant to outlive its file.
--
-- Found the hard way: the first run of the sweep deleted the object from
-- R2 and then failed to clear the key, leaving the row pointing at a file
-- that no longer existed and the sweep retrying it forever. Deleting the
-- object before updating the row is still the right order — the reverse
-- orphans files in the bucket — but it only works if the update can
-- actually succeed.
ALTER TABLE id_documents ALTER COLUMN s3_key DROP NOT NULL;

-- Drives the retention sweep: find decided documents whose file is still
-- present. Partial, because rows with no file are the majority once the
-- policy has been running and are never candidates.
CREATE INDEX IF NOT EXISTS idx_id_documents_retention
  ON id_documents (status, reviewed_at)
  WHERE s3_key IS NOT NULL;

COMMENT ON COLUMN id_documents.purged_at IS
  'When the underlying file was deleted from object storage under the retention policy. The row itself is kept permanently as the verification audit trail.';
