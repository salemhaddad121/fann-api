-- =============================================================
-- Fann — Email Change Migration
-- 008_fann_email_change.sql
-- Run after 001-007.
--
-- Supports changing a logged-in user's email address without trusting
-- the new address immediately. requestEmailChange() (auth.service.ts)
-- sets pending_email and re-sends the existing verification email to
-- that address instead of the current one. Only once the user clicks
-- that link does verifyEmail() copy pending_email into email and clear
-- this column — the current (old) email keeps working for login the
-- entire time the change is pending.
-- =============================================================

ALTER TABLE users ADD COLUMN pending_email VARCHAR(255);
