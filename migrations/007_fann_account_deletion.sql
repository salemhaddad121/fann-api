-- =============================================================
-- Fann — Account Deletion Migration
-- 007_fann_account_deletion.sql
-- Run after 001-006.
--
-- Soft-delete only: deleting an account does NOT remove the row
-- (bookings/reviews/messages reference it, and that history should
-- survive one party leaving). Deletion reuses the existing 'banned'
-- status so every existing exclusion check (search, login) already
-- covers it, and deleted_at distinguishes "left on their own" from an
-- admin ban in the UI.
-- =============================================================

ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;
