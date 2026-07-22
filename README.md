# Fann API — Project Structure

## Status snapshot

**A note on this file's history, worth being upfront about:** this snapshot was last properly
updated before several rounds of frontend-driven backend work (Saved artists, `public-info`,
flag-resolution notifications, account deletion, tests) — it still said *"No frontend app code
yet"* as a known gap until this update, which was simply wrong by the time this was read. That
work has been kept documented in the **frontend** repo's README instead, session to session,
since that's where it was driven from. This update brings the snapshot back in line with reality
and adds a dedicated section below for the backend-focused session that prompted this pass —
TypeScript errors, httpOnly cookie migration, and three smaller features.

**Working / built:**
- Auth (register, login, OTP via WhatsApp Business Cloud API, social login, forgot/reset
  password, logged-in password change, self-service email change), Users, Redis
- **Auth tokens are httpOnly cookies**, not JSON-body tokens — see "Auth: httpOnly cookies" below.
- Email (Resend) — verification, password reset, and review-request emails, shared `EmailModule`
- Artists, Planners (including `GET /planners/event-types` for the search chip row), Media (S3),
  Availability, Messaging, Notifications, Saved (planner favorites)
- Admin: user management, ID-document manual review, payment manual confirmation, flags
  (with notifications on resolution), audit log, category + category-group CRUD, real analytics
  (signups-by-day, top-cities — derived from existing columns, no fabricated numbers)
- Bookings, Reviews (with anonymity gate), Scheduler (cron for review requests)
- Multi-select grouped categories (up to 4 per artist, 6 groups, 36 categories)
- Account deletion — soft delete (`DELETE /auth/me`), reuses the `banned` status plus a
  `deleted_at` column, email anonymized on delete
- Seed data (`migrations/009_fann_seed_data.sql`) — 11 users (1 admin, 6 artists, 4 planners)
  across every status, media, ID documents, availability blocks, conversations/messages, 4
  bookings across every state, reviews, notifications, payments, a flag, and audit log. Password
  for every seeded user: `Fann@dev2025`.
- Tests (`npm test`, Jest) — 53 tests across 8 suites; see "Tests" below.

**Known gaps:**
1. WhatsApp OTP requires a Meta-approved "authentication" template before it will actually send —
   see `.env.example` for setup notes.
2. Google/Apple sign-in are inert until their credentials are set — the app boots and everything
   else works, but those routes answer 503. See "OAuth providers are optional" below.
3. **S3 bucket CORS is not something this repo can fix** — it needs to be set directly in the AWS
   console. The exact policy JSON is written up in `docs/s3-cors-setup.md`. Until it's applied,
   media uploads will fail from the browser with a CORS error (the frontend now detects this
   specific failure mode and points at that doc instead of showing a generic error).
4. The httpOnly cookie `SameSite=Lax` choice (see below) assumes the frontend and backend end up
   on the same parent domain in production. If they're ever deployed to fully unrelated domains
   instead, this needs revisiting — `SameSite=None` would be required for cross-site cookies to
   be sent at all, and that requires adding a real CSRF token on top, since `None` doesn't carry
   CSRF protection the way `Lax` does.

## Folder structure
- `src/` — NestJS backend, one folder per module (controller, service, module, dto/); `common/`
  holds small shared helpers used across modules (`db.util.ts`, `config.util.ts`)
- `migrations/` — SQL schema files, run in numeric order via `npm run migrate`
- `scripts/` — `migrate.sh`, the migration runner behind `npm run migrate`
- `docs/` — setup docs that live outside the app code (currently just `s3-cors-setup.md`)
- `design/` — HTML screen mockups, API spec, ERD, project doc
- `assets/images/` — reference images used in mockups

## Running it locally

```bash
npm install
cp .env.example .env      # fill in JWT_SECRET / JWT_REFRESH_SECRET at minimum
createdb fann             # or: psql -c 'CREATE DATABASE fann;'
npm run migrate           # applies migrations/*.sql in numeric order
npm run start:dev
```

`npm run migrate` runs each file in `migrations/` in numeric order, one transaction per file,
stopping at the first error. It reads `DB_*` from `.env` (real environment variables win) and
needs `psql` on PATH.

**Only `JWT_SECRET` and `JWT_REFRESH_SECRET` are genuinely required to boot.** Google/Apple
sign-in, WhatsApp OTP, Resend email, and S3 all degrade rather than block startup — see
"OAuth providers are optional" below. Anything else that's genuinely required fails at boot
naming the missing variable (`src/common/config.util.ts`'s `requireConfig`), rather than
surfacing as a confusing error later.


## Audit pass: migration order, OAuth boot crash, dependency CVEs

_(This section documents an external audit pass; the session notes below it predate it.)_

Three things an external audit found by actually building and booting both repos against a real
Postgres + Redis, rather than reading the code. All three were reproducible from a clean clone.

### Seed migration renumbered 002 → 009

**`migrations/` could not be applied in the order this README told you to apply them.**
`002_fann_seed_data.sql` inserts into `artist_categories`, which is only created by
`005_fann_category_groups_multiselect.sql` — so a numeric-order run on a fresh database died with
`relation "artist_categories" does not exist`. The file's own header comment had said "Run after
001, 003, 004, 005", which is to say the ordering bug was known and documented in the one place
nobody looks until it breaks.

Fixed by renaming it to `009_fann_seed_data.sql`, so numeric order *is* dependency order and seed
data lands last where it belongs. **There is deliberately no `002` any more** — renumbering the
already-applied schema files `003`–`008` would break every database that has run them, and a gap
in the sequence is harmless. Verified by dropping the database and re-running: all 8 files apply
clean, and the seeded row counts are identical to before (11 users, 36 categories, 9
artist_categories, 4 bookings, 3 reviews, 7 messages).

`npm run migrate` now enforces the order mechanically, which is the actual fix — the ordering was
only ever guaranteed by a README sentence, which is why it drifted.

### OAuth providers are optional

**The backend could not boot from a clean `.env.example`.** `passport-google-oauth20` and
`passport-apple` both throw synchronously from their constructors when handed an empty
`clientID`, and Nest instantiates every provider at bootstrap — so the process died before
binding a port, with `OAuth2Strategy requires a clientID option`. `.env.example` ships those
values blank, so the documented setup path was a crash. It's the same failure shape as the
missing `@aws-sdk` dependency from the earlier session: fine in every code review, fatal the
moment anything actually runs.

A Passport strategy registers itself with Passport *from its constructor*, so "don't register
this provider" and "don't construct it" are the same operation. `auth.module.ts` now builds each
strategy through a factory that returns `null` when that provider's credentials are absent,
logging a warning naming the missing variables. `src/auth/oauth-config.util.ts` holds the
required-key lists so the module and the routes can't drift apart.

The routes then need to say something sensible, since an unregistered strategy makes
`AuthGuard('google')` fail with an opaque `Unknown authentication strategy` 500.
`GoogleConfiguredGuard`/`AppleConfiguredGuard` run first and return a **503 naming the missing
variables** instead.

Providers are independent: configuring Google alone leaves Apple cleanly disabled. Verified both
directions — blank credentials boot and 503; real credentials produce a correct 302 to
`accounts.google.com`.

### Dependency CVEs, and one upgrade that needed doing by hand

Production dependencies went from **15 known vulnerabilities (6 high, 9 moderate) to 0**.

Worth recording *how*, because `npm audit fix --force` on its own left the tree in a state that
type-checked and built but was not actually supported: it bumped `@nestjs/core` and
`@nestjs/platform-express` to 11 while leaving `@nestjs/common` on 10. Nest requires those to
share a major. The rest of the family (`common`, `jwt`, `passport`, `cli`, `testing`) was aligned
to 11 by hand afterwards.

The upgrade then surfaced two latent bugs through stricter Passport typings, both the same shape:
`JWT_SECRET` and the Google client credentials were being passed as `string | undefined`. A
missing `JWT_SECRET` would have failed somewhere downstream and unhelpfully. `requireConfig()` in
`src/common/config.util.ts` now throws at boot naming the variable.

Re-verified after the upgrade, not just assumed: 0 type errors, clean build, **53/53 tests**, and
the full cookie cycle driven with curl again (login → authenticated request → refresh → logout →
correctly-rejected request), because Express 5 is where cookie handling would plausibly have
regressed. `HttpOnly`/`SameSite=Lax` intact, no tokens in any response body, role gating and DTO
validation unchanged.

**One CVE was deliberately left open.** The frontend reports 2 moderate advisories against
`postcss 8.4.31`, which is vendored *inside* Next.js. `npm audit fix --force` "fixes" this by
downgrading Next from 16.2.10 to **9.3.3** — seven majors back, and far more dangerous than the
advisory. 16.2.10 is the current release, so there's no clean path today. **Don't run `--force`
in the frontend repo**; re-check when Next ships a patched postcss.

## Earlier session: TypeScript errors, httpOnly cookies, and three smaller features

### 25 pre-existing TypeScript errors — fixed, and one of them wasn't just a type nuisance

Re-ran `npx tsc -p tsconfig.json --noEmit` fresh rather than trusting the number handed down —
still exactly 25. 18 were the same shape: Knex types `.first()` as `T | undefined` under
`strictNullChecks`, but a bare aggregate query (`COUNT`/`MAX`, no `GROUP BY`) always returns
exactly one row at runtime. Fixed with one shared helper (`src/common/db.util.ts`'s
`aggregateValue()`) instead of repeating `row?.key ?? 0` at 18 call sites.

**Two of the other seven were a real, previously-invisible bug, not a type nuisance:**
`media.service.ts` imports `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, but neither
was ever added to `package.json`. This meant **the entire backend could not boot at all**, in
`start:dev` or a production build — confirmed by actually running it, not just reading the error:
`node dist/src/main.js` crashed immediately with `Cannot find module '@aws-sdk/client-s3'`. Fixed
by installing both as real dependencies; the app now boots cleanly (verified end-to-end against a
real Postgres + Redis, including the full login → authenticated request → refresh → logout cycle
over httpOnly cookies — see below).

One more real bug surfaced by the same pass: `dto.durationSec > MAX_VIDEO_SECONDS` in
`media.service.ts` silently evaluated to `false` whenever `durationSec` was `undefined` (JS
comparisons against `undefined` are always `false`), so **a video upload with no duration sent
skipped the 60-second cap entirely.** Now throws a clear `BadRequestException` if a video's
duration is missing, rather than quietly letting it through.

Also simplified: `tsconfig.spec.json` / `isolatedModules: true` existed purely to route around
these 25 errors during `npm test`. Removed now that they're fixed — tests type-check against the
real `tsconfig.json` directly, so a regression that reintroduces a type error fails `npm test` too,
not just `npm run build`.

### Auth: httpOnly cookies

`/auth/login`, `/auth/refresh`, and `/auth/logout` used to return `accessToken`/`refreshToken` as
plain JSON in the response body. They're now set as httpOnly cookies via `res.cookie(...)`
instead — a real security improvement: a token in a JSON body typically ends up in `localStorage`
or similar on the client, readable by any JS running on that page (including an XSS payload). An
httpOnly cookie isn't readable by JS at all.

**What changed, concretely:**
- `main.ts` registers `cookie-parser` middleware.
- `JwtStrategy` reads the access token from the cookie first, falling back to the
  `Authorization: Bearer` header — kept as a fallback (not removed) so a future non-browser client
  (the React Native app in the project's longer-term plans) can still authenticate without
  cookies, which don't behave the same way outside a browser.
- `refresh` reads the refresh token from the cookie instead of a request body — `RefreshTokenDto`
  is gone, nothing used it once that changed.
- The Google/Apple OAuth callbacks now set cookies directly and redirect to a bare
  `/auth/callback` with no query params. **This closes a gap the original cookie-migration ask
  didn't mention but was the same underlying issue:** they used to embed raw tokens in the
  redirect URL, which end up in browser history and server access logs — a real, if minor, leak
  vector of their own.
- `DELETE /auth/me` (account deletion) now also clears the cookies, matching `logout` — the
  original ask only mentioned login/refresh/logout, but leaving a cookie behind after the account
  is soft-deleted was an obvious gap once the rest was done. (It goes on being functionally dead
  the moment `status` flips to `banned`, since every guard checks that — but there's no reason to
  leave it sitting there regardless.)
- Single source of truth for cookie names/options: `src/auth/auth-cookie.util.ts`.

**The `SameSite`/CSRF decision, spelled out rather than silently picked:** cookies are set with
`SameSite=Lax`, `httpOnly: true`, and `secure` only in production (a `Secure` cookie is dropped
entirely over plain HTTP, which is what local dev uses). `Lax` already blocks the classic CSRF
vectors — a cross-site page can't trigger a cookie-authenticated state-changing request against
this API — and there are no cross-site form posts anywhere in the app, so no separate CSRF token
was added on top of it. This assumes the frontend and backend end up **same-site** (SameSite is
based on registrable domain, not port or subdomain — `localhost:3000`/`localhost:4000` in dev, or
e.g. `app.aynu.com`/`api.aynu.com` in production, both count as same-site). If they're ever
deployed to genuinely unrelated domains instead, this needs revisiting.

**Verified end-to-end, not just typechecked:** installed a real Postgres + Redis and ran the
actual `dist/src/main.js`, then drove the full cycle with curl and a cookie jar — login (correct
Set-Cookie headers, response body has no token fields), an authenticated request using only the
cookie, a request with no cookie correctly rejected, refresh (rotates the access-token cookie),
and logout (clears both cookies, subsequent request correctly rejected).

### `GET /planners/event-types`

New, public. `planner_profiles.event_types` is free-text JSONB with no reference table — this
returns the distinct values actually in use, scoped to active planners (matching `search()`'s own
visibility rule, since a chip from a pending/suspended profile would return zero results if
selected):
```sql
SELECT DISTINCT et.value AS event_type
FROM planner_profiles pp
JOIN users u ON u.id = pp.user_id
CROSS JOIN LATERAL jsonb_array_elements_text(pp.event_types) AS et(value)
WHERE u.status = 'active'
ORDER BY et.value ASC
```
Registered before the existing `GET /planners/:id` in the controller — same reason `/planners/me`
already had to be, or Express would match `event-types` as the `:id` param.

### Email change (`PATCH /auth/email`)

Didn't exist before — `/account` only had password change and account deletion. Mirrors
`changePassword`'s shape (current password required to confirm; OAuth-only accounts skip that
check, since there's nothing to verify against and they're already authenticated via their
session), but **doesn't take effect immediately**: it sets a new `pending_email` column
(migration `008`) and re-sends the *existing* verification-email flow — but to the new address,
not the current one — rather than trusting it right away.

`verifyEmail()` (the same handler `/auth/verify-email?token=` has always used, for the original
signup flow too) now forks on whether the user has a `pendingEmail` set: if so, this confirmation
is for a change, so it promotes `pending_email` into `email` and marks it verified in one update,
rather than just flipping the verified flag on the address that was already there. The current
email keeps working for login the entire time a change is pending. A same-email "change" is
rejected outright, and a target already claimed by another account is rejected with a 409 both at
request time (a `findByEmail` check) and defensively again at confirmation time (in case two
people request the same address in the same window — the second confirmation to land hits the
`email` column's unique constraint and gets a clean error instead of a raw 500).

Verified end-to-end against real seeded data: requested a change with the wrong password
(rejected), then the right one (accepted, email unchanged, `pending_email` set, dev-mode email
logged with the real token), confirmed old-email login still worked during the pending window,
confirmed via the token, then verified old-email login now fails and new-email login works.

### Nothing else changed for the admin Flags profile-link feature

Worth noting for completeness: linking `profile`-type flags to a real profile (the frontend's
`FlagsTab.tsx`) needed no backend changes at all — `GET /users/:id/public-info` already existed
and already returns exactly what's needed (`role` + `profileId`) for a bare user id, which is what
`flags.target_id` already is for `profile`-type flags.


## Tests

`npm test` (Jest), 53 tests across 8 suites — a real foundation, not exhaustive coverage:
- Service-level unit tests against a hand-rolled Knex mock (`src/test-utils/knex-mock.ts`) for
  business logic worth protecting: booking status-transition guards, the review mutual-blind
  window and unlock-on-pair logic, new-message notification dedup, flag-resolution paths, the new
  `planners.getEventTypes()` (mapping/empty-array cases), and the new email-change flow
  (`requestEmailChange`/`verifyEmail`'s forked behavior) — the first spec file for `AuthService`,
  which takes several injected services rather than a single `db` connection, so it mocks each one
  directly instead of using the shared Knex mock.
- DTO validation tests (password strength regex, review score bounds).

Nothing here does integration/e2e testing against a real database — that's the natural next layer
if this is worth investing in further (this session's manual verification used a real local
Postgres + Redis for exactly that reason, but it wasn't wired into the automated suite).

## Next up

What's actually open right now, as far as this pass could tell:
- Applying the S3 CORS policy in the real AWS console (`docs/s3-cors-setup.md` has the exact
  JSON) — an account-access step, not fixable from either repo.
- The 2 open `postcss` advisories in the frontend, which can only be closed by Next.js shipping
  a patched copy — see the audit section above, and do not "fix" them with `--force`.
- Test coverage is 15% of statements / 12.5% of functions; controllers and the artists,
  availability, media, notifications, saved and scheduler services are at 0%. The 53 tests cover
  the business logic most worth protecting, but a passing suite currently proves less than it
  looks like it does.
- Rate limiting. There's nothing throttling `/auth/login`, `/auth/send-otp`, or
  `/auth/forgot-password` — all three are worth `@nestjs/throttler` before this is public.
- Revisiting the cookie `SameSite` choice if the frontend and backend ever end up on genuinely
  unrelated domains instead of a shared parent domain.
- Integration/e2e test coverage against a real database, if that's worth the infrastructure.
- Whatever surfaces from actually using this day to day.
