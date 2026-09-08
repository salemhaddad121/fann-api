-- =============================================================
-- 021: marketing consent — separable, and withdrawable
--
-- T&C §24.2 requires that consent to marketing be separate from accepting
-- the Terms, and that it can be withdrawn. 016 gave us somewhere to record
-- an acceptance but nothing here satisfies §24.2 on its own:
--
--   * consent_document was ('terms', 'privacy'). There was no way to say
--     "agreed to marketing" at all, so signup could not offer the optional
--     checkbox §24.2 asks for.
--
--   * Nothing could express a WITHDRAWAL. Every row in user_consents means
--     "agreed", so the only way to revoke was to delete the row — which
--     destroys the evidence that consent was ever given, and leaves no
--     record that it was withdrawn or when. For a document you must accept
--     to use the platform that gap never showed, because terms and privacy
--     are conditions of use and cannot be withdrawn while the account
--     lives. Marketing is the first consent that can be taken back.
--
-- `granted` is what closes it. A withdrawal APPENDS a row with
-- granted = false rather than deleting or updating anything, which keeps
-- the table append-only exactly as 016 intended — read the latest row per
-- document by accepted_at and that boolean is the current answer. The
-- history then reads as what actually happened: agreed on this date,
-- withdrew on that one, agreed again later. An UPDATE would have shown
-- only the final state and thrown away the one thing a regulator asks for.
--
-- Defaulting to TRUE is the correct backfill, not a convenience: every row
-- that exists today is an acceptance of terms or privacy, and every one of
-- them was granted.
--
-- contact_email closes a separate gap, in the same table because it is the
-- same evidence. §3.4 asks that an acceptance retain the user's CONTACT
-- alongside the timestamp and version. Joining users.email would answer a
-- different question — the address they use NOW — and the platform has an
-- email-change flow, so those two drift apart the first time someone uses
-- it. Nullable because a consent recorded outside a request (a backfill,
-- an admin action) legitimately has no address to snapshot, and a blank
-- string would read as though we captured one.
--
-- On ALTER TYPE inside a transaction: scripts/migrate.sh runs each file
-- with --single-transaction, which is fine here. PostgreSQL 12+ permits
-- ADD VALUE in a transaction block; what it forbids is USING the new value
-- in that same transaction. This file only adds it — the first row saying
-- 'marketing' is written later, by the API.
--
-- Idempotent: guarded throughout.
-- =============================================================

ALTER TYPE consent_document ADD VALUE IF NOT EXISTS 'marketing';

ALTER TABLE user_consents
  ADD COLUMN IF NOT EXISTS granted BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE user_consents
  ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);

COMMENT ON COLUMN user_consents.granted IS
  'FALSE marks a withdrawal. Read the latest row per (user_id, document) by accepted_at; that row''s value is the current standing. Never UPDATE an existing row — append.';

COMMENT ON COLUMN user_consents.contact_email IS
  'The address on the account AT THE TIME of this consent (T&C 3.4). Deliberately not a join to users.email, which changes.';
