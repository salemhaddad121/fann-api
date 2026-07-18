-- =============================================================
-- 004 — Category management audit actions
-- Adds the audit_action values needed for admin category CRUD.
-- Safe to run without recreating the enum type.
-- =============================================================

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'category.created';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'category.updated';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'category.deleted';
