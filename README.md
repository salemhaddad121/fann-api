# Fann API — Project Structure

## Status snapshot (as of this reorg)

**Working / built:**
- Auth (register, login, OTP via WhatsApp Business Cloud API, social login, forgot/reset password), Users, Redis
- Email (Resend) — verification, password reset, and review-request emails, shared `EmailModule`
- Artists, Planners, Media (S3), Availability, Messaging, Notifications
- Admin: user management, ID-document manual review, payment manual confirmation, flags, audit log, category + category-group CRUD
- Bookings, Reviews (with anonymity gate), Scheduler (cron for review requests)
- Multi-select grouped categories (up to 4 per artist, 6 groups, 36 categories)
- Seed data (`migrations/002_fann_seed_data.sql`) — rebuilt from scratch to match the current schema (previous version referenced the old single-category FK, which no longer exists). Covers every table: 11 users (1 admin, 6 artists, 4 planners) across every status, media, ID documents (1 pending, 5 approved), availability blocks, conversations/messages, 4 bookings demonstrating every state (upcoming, completed-review-pending, completed-both-reviewed, declined), reviews showing both the hidden and revealed anonymity states, notifications, payments, a flag, and audit log. Password for every seeded user: `Fann@dev2025` (real, verified bcrypt hash included in the file).

**Known gaps (see conversation history for full list):**
1. No frontend app code yet (Next.js/React web, React Native mobile) — only static HTML mockups in `design/screens/`
2. WhatsApp OTP requires a Meta-approved "authentication" template before it will actually send — see `.env.example` for setup notes

## Folder structure
- `src/` — NestJS backend, one folder per module (controller, service, module, dto/)
- `migrations/` — SQL schema files, run in numeric order
- `design/` — HTML screen mockups, API spec, ERD, project doc
- `assets/images/` — reference images used in mockups
