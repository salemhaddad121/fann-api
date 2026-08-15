# Fann API — Project Structure

## Status snapshot

**A note on this file's history, worth being upfront about:** this snapshot has drifted from
reality more than once. It previously claimed *"No frontend app code yet"* long after the frontend
existed, and until this pass it still reported 53 tests across 8 suites and listed rate limiting
as missing — both stale by a wide margin. It is now current as of the seven-wave build
(migrations through `018`, subscriptions through payment providers). The older session sections
below are kept as written: they record why particular decisions were made, and rewriting them
would lose that.

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
- Tests (`npm test`, Jest) — 179 tests across 20 suites; see "Tests" below.

**Added by the seven-wave build (migration `018` onward) — see "The seven waves" below:**
- **Subscriptions** — day $5 / month $15 / year $100. Day access sells as *credits* that sit
  unused until activated, because payment confirmation is a human confirming a transfer and can
  take hours. Purchases made while a plan is running are *queued*, not overlapped.
- **Payments are provider-agnostic** — `PaymentProvider` interface with `manual` (working, and
  the permanent fallback), `mock` (working, dev-only, exercises the full automated path), and
  `whish` / `omt` stubs. Webhooks are recorded before validation, signature-checked over the raw
  body, amount-verified against the stored intent, and idempotent on replay.
- **Guest browsing** — search and artist profiles are open to signed-out visitors, with names
  masked, prices banded and social links withheld **server-side**. Booking terms (deposit,
  cancellation policy) are deliberately public to every tier.
- **Analytics** — guest-capable telemetry keyed on a `sessionStorage` session id, search events
  recorded server-side, admin aggregates (session duration, time per page, category demand,
  guest/authenticated split), and a real multi-sheet `.xlsx` export via `exceljs`.
- **Support tickets** — `/support/tickets` open to guests, staff replies, admin queue.
- **Rate limiting** — `@nestjs/throttler` on auth, telemetry and support.

**Known gaps:**
1. WhatsApp OTP requires a Meta-approved "authentication" template before it will actually send —
   see `.env.example` for setup notes.
2. Google/Apple sign-in are inert until their credentials are set — the app boots and everything
   else works, but those routes answer 503. See "OAuth providers are optional" below.
3. **S3 bucket CORS is not something this repo can fix** — it needs to be set directly in the AWS
   console. The exact policy JSON is written up in `docs/s3-cors-setup.md`. Until it's applied,
   media uploads will fail from the browser with a CORS error (the frontend now detects this
   specific failure mode and points at that doc instead of showing a generic error).

   The media client is provider-agnostic: it uses AWS S3 by default, or any S3-compatible
   provider (Cloudflare R2, MinIO, …) when `S3_ENDPOINT` is set — add `S3_FORCE_PATH_STYLE=true`
   and `AWS_REGION=auto` for R2. Leave `S3_ENDPOINT` blank for AWS. The presign/upload flow is
   identical either way. See `.env.example`.
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

### Option A — Docker (recommended, no local Node/Postgres/Redis needed)

The only prerequisites are Docker (Desktop on macOS/Windows) and Git. Clone the
frontend repo as a **sibling** of this one, then:

```bash
# <parent>/fann-api  +  <parent>/Fann---Web  side by side
cd fann-api
docker compose up -d --build
```

That starts Postgres 18, Redis 7, applies every migration (including seed
data) to a fresh database, and brings up the API on
`http://localhost:4000/api/v1` and the web app on `http://localhost:3000`.
Log in with any seeded account (see `migrations/009_fann_seed_data.sql`),
password `Fann@dev2025`.

Notes:
- Migrations only run against an empty database (there's no
  applied-migrations tracking). To re-run them from scratch:
  `docker compose down -v && docker compose up -d`.
- JWT secrets default to throwaway dev values; override `JWT_SECRET` /
  `JWT_REFRESH_SECRET` via the environment for anything non-local. The same
  goes for the placeholder AWS values — media uploads need real credentials.
- Base images come from `public.ecr.aws/docker/library/*` — the same official
  images as Docker Hub, without Hub auth/rate-limit issues.

### Option B — natively

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


## The seven waves

Built against `FANN-CHANGE-PLAN.md`, in dependency order. Each was its own branch, verified
against a real local Postgres rather than only typechecked, with the seed baseline restored
afterwards. What follows is the reasoning worth keeping, not a changelog.

**Wave 0 — migration `018`.** Everything schema-level in one idempotent file: subscriptions,
payment provider columns, the webhook audit table, artist deposit/cancellation terms, support
tickets, and guest telemetry. Three things the plan missed and this migration fixes: `payments`
had `period_start`, `period_end` and `transfer_service` as `NOT NULL`, which a purchase intent
cannot fill — a day-pass credit has no period until someone activates it. Note also that
`scripts/migrate.sh` runs each file with `--single-transaction`, and Postgres forbids *using* a
newly added enum value in the transaction that added it, so any backfill using
`awaiting_provider`/`paid`/`disputed` must go in a later file.

**Wave 1 — auth primitives.** `OptionalJwtAuthGuard` resolves a session when a cookie is present
and returns null when it is not; it never rejects, because on a guest-friendly route a missing,
expired or malformed token all mean "serve the guest view". `getActiveSubscription()` is the one
place paid access is decided, and it verifies `expires_at` rather than trusting `status` —
status is flipped by a cron, and the gap between lapsing and the next run would otherwise be free
access. `main.ts` gained `rawBody: true` here, one line, because webhook signatures are an HMAC
over the exact bytes sent and re-serialised JSON does not reproduce them.

**Wave 2 — subscriptions.** Stacking is the interesting part: a purchase made while a plan is
running is queued with `expires_at` left NULL and filled in *at promotion*, so an early
cancellation or an admin adjustment shifts the whole chain instead of leaving a stale date.
`mintForPayment()` is the only code that turns a payment into access — the admin confirm button
and the Wave 7 webhook both call it, and it refuses to mint twice for one payment.

**Wave 3 — guest experience.** Shaping is server-side and column-level: `findOne` no longer
selects `ap.*`, and both it and `search` take an explicit allowlist per tier, so a column added
to `artist_profiles` later stays private until someone exposes it deliberately. Three tiers, not
two — guests and registered users get identical *data*, but the API reports which it saw so the
client can ask for the right thing ("sign in" vs "subscribe"). Two viewers bypass the paywall: an
artist opening their own profile, and an admin moderating one.

**Wave 4 — analytics.** Searches are recorded from inside the search handler, never posted by the
client, because a client-reported count is trivially inflated and these numbers exist to decide
which categories to recruit for. Session duration discards single-event sessions — a one-page
session has no measurable duration, and leaving bounces in makes the metric describe bounce rate.
The 90-day prune documented in `014` is now actually wired, and covers `search_events` too.

**Wave 5 — support.** Open to guests, because the people most likely to need help are the ones
who cannot get in. A signed-in user's address comes from their account and any `guestEmail` in the
body is ignored. Ticket creation never fails on a notification problem: the row is the source of
truth, and reporting failure would make someone retype a message already saved.

**Wave 6 — batched UI.** Admin logout (an admin genuinely could not sign out — logout lives in the
sidebar, `ADMIN_NAV` is empty by design, and `TopNav` only links to `/account`), account code
hidden from the profile but kept as the reconciliation key, deposit and cancellation terms, the
artist media minimum, and the site footer.

**Wave 7 — payment providers.** See `src/payments/providers/README.md` for the full contract and
what each real provider will need. The webhook ordering is the design: record before validating,
verify over raw bytes, match on `(provider, provider_ref)`, compare amount *and* currency against
the stored intent, no-op if already confirmed, and only then mint. Webhooks always answer 200 even
when rejected, because most providers treat 4xx as retry and will hammer for hours.

### Things that were fixed along the way, not planned

- **Rate limits were declared but not enforced.** `@Throttle` configures a bucket; `ThrottlerGuard`
  enforces it, and this project opts routes in one at a time. `/support/tickets` and
  `/analytics/page-views` carried the decorator without the guard, so both were unlimited while
  reading as though they were not.
- **`npm start` never worked.** `tsconfig.json` declares no `include`, so `jest.setup.ts` at the
  repo root widened the compile root and `main.ts` landed at `dist/src/main.js`. Fixed with
  `tsconfig.build.json`. Docker was never affected — its `COPY` steps never included that file —
  but it *was* shipping 20 compiled spec files into the production image, which the same fix
  removes.
- **`PaymentsTab` fed `null` to `new Date()`**, rendering "Invalid Date" once plan purchases
  stopped carrying a period, and its service labels were keyed on lowercase strings the
  `payment_service` enum never produces.


## Scheduled work: `SCHEDULER_MODE`

Six jobs run on a schedule. They can be driven two different ways, and which one is correct
depends entirely on **where the API is deployed** — not on preference.

| Job | Schedule | What it does |
|---|---|---|
| `daily-review-trigger` | `0 6 * * *` | Marks played bookings completed, sends review requests |
| `expired-review-unlock` | `30 6 * * *` | Unlocks reviews whose 7-day mutual-blind window lapsed |
| `telemetry-prune` | `0 7 * * *` | Deletes `page_events` + `search_events` past 90 days |
| `subscription-maintenance` | `0 * * * *` | Expires lapsed subscriptions, promotes queued ones |
| `renewal-reminders` | `0 8 * * *` | Warns before a plan ends (year 30/7/1, month 3, day none) |
| `payment-reconciliation` | `*/15 * * * *` | Polls hanging provider intents, expires stale ones |

### The two modes

`SCHEDULER_MODE=in-process` (the default) keeps the `@Cron` decorators in `SchedulerService`
live. `SCHEDULER_MODE=http` disables them and instead exposes `/api/v1/cron/*`, which Vercel Cron
calls on the schedules in `vercel.json`, authenticated with `CRON_SECRET` compared in constant
time. The flag is what stops both triggers firing at once — every job has a `@Cron` wrapper that
returns early in `http` mode, and a plain `runX()` method that both paths call.

**`@Cron` needs a process that stays alive.** That is true in the Docker container and false on
Vercel, where each request is a short-lived function — the decorators would simply never fire.
So the mode is dictated by the host:

- **API on Vercel** → `SCHEDULER_MODE=http`. There is no alternative; in-process crons silently
  do nothing, which is the worst possible failure mode for scheduled work.
- **API in a long-lived container** (Railway, Fly, Render, a VPS running this `Dockerfile`) →
  `SCHEDULER_MODE=in-process`, and `vercel.json`'s `crons` block becomes dead weight.

### Trade-offs, if the choice is ever open

In-process is simpler: no shared secret, no HTTP round trip, any schedule you like down to the
minute, and no execution time limit. Its weakness is horizontal scaling — **every instance runs
its own crons**, so a second container means every job fires twice. Closing that needs an advisory
lock or a leader election before scaling out. Nothing here does that yet, because nothing here
runs more than one instance yet.

Vercel Cron has the opposite shape: one endpoint called once, so duplication is impossible no
matter how many instances Vercel spins up. It costs a `CRON_SECRET`, and every job becomes an
HTTP request subject to the platform's function timeout. `telemetry-prune` is the one to watch —
it is a single unbounded `DELETE` over two tables that only grows, and it is the first job that
will exceed a timeout as traffic builds. If it starts failing, that is the signal to either batch
the delete or move to in-process, not to raise the timeout.

Cron frequency is also plan-gated on Vercel: Hobby is daily-only, which is why the hourly and
15-minute entries were written at full frequency but did not actually run until the account moved
to Pro. They are not degraded copies — the schedules in `vercel.json` are the intended ones.

### Gotcha: Vercel Cron invokes with GET

Every `/api/v1/cron/*` route answers **both** GET and POST for this reason. It was POST-only until
2026-08-07, so every scheduled run since the project went live returned 404 and none of the work
ran in production — visible in the runtime logs as `GET /api/v1/cron/telemetry-prune 404` in the
`0 7 * * *` slot. Stacking `@Get` and `@Post` on one handler does **not** register both: the
second decorator overwrites the first, so each job has a thin handler per verb delegating to one
implementation. POST is kept so jobs can still be triggered by hand with curl.

### Why two of these are not daily

`subscription-maintenance` is hourly because a day pass activated at 14:20 lapses at 14:20, and a
daily sweep would leave a queued plan waiting up to 23 hours before starting. Access itself is
never wrong in between — `getActiveSubscription()` verifies `expires_at` rather than trusting
`status`, so a lapsed row stops granting access the moment it lapses whether or not the job has
run. What the job fixes is the bookkeeping and the promotion.

`payment-reconciliation` runs every 15 minutes because it is the safety net for providers that
have no webhook at all. If OMT turns out to be reference-matching, polling is the primary path
rather than a fallback, and the interval is how quickly a paid customer gets what they bought.


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

`npm test` (Jest), **179 tests across 20 suites** — a real foundation, not exhaustive coverage.
Statement coverage is ~25%, and that number is worth reading carefully: the suites deliberately
concentrate on logic where being wrong costs money or leaks data, and leave controllers and thin
CRUD services largely uncovered. A passing run proves the rules below hold; it does not prove the
app works, which is why every wave was also verified against a real Postgres by hand.

What the newer suites protect:
- **Subscription stacking** — that a day pass mints as an unactivated credit, that a purchase made
  while a plan runs is queued with no expiry, and that minting refuses to run twice for one payment.
- **Webhook handling** — replay is a no-op, a bad signature mints nothing, and a *correctly signed*
  webhook claiming the wrong amount or currency is marked disputed rather than confirmed.
- **Guest shaping** — that no paywalled field survives shaping for a guest or a registered user,
  that the masking never leaks a surname, and that booking terms reach every tier.
- **Name masking** — single-word names, band names with connectors, Arabic script, and emoji
  (which must not be sliced into a lone surrogate).
- **Telemetry** — that identity comes from the session and never the payload, and that a failed
  search-event insert cannot turn a working search into a 500.

The original foundation, still in place:
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

What's actually open right now.

**Needs an account or a decision, not code:**
- **R2 bucket CORS and `ExposeHeaders: ETag`** — a Cloudflare dashboard action
  (`docs/s3-cors-setup.md`). Until it is applied, browser uploads fail, and without the ETag
  header the uploader hangs at 100% and orphans the file.
- **`CDN_BASE_URL` points at `cdn.fann.guru`**, which still needs binding as an R2 custom domain —
  but **not before the identity documents are moved out of `fann-media`.** Both public media
  (`uploads/`) and government ID scans (`identity/`) live in that one bucket, and an R2 custom
  domain grants public read to the whole bucket with no way to scope it to a prefix. Binding it
  today would publish every artist's ID at a guessable-shaped URL and quietly undo the isolation
  `identity-documents.service.ts` is built around. Steps and the fix in
  `docs/cloudflare-console-steps.md`.
- **`SUPPORT_INBOX_EMAIL` is unset.** Tickets are always saved; the notification currently falls
  back to `EMAIL_FROM` so it reaches a real inbox rather than vanishing.
- **Payment provider credentials.** `src/payments/providers/README.md` lists exactly what Whish
  and OMT each need. Until then `PAYMENT_PROVIDER=manual`, which works.

**Known and deliberately deferred:**
- **Artist ID + selfie verification is not built.** An unverified artist is currently listed and
  bookable. `artist_profiles.is_verified` is a display badge with no enforcement behind it,
  `id_documents` is only an admin review queue, and `src/verification/` is an audit log. This is
  the largest outstanding gap.
- **Masked names can be confirmed by probing.** `?q=` still filters on the real `display_name`,
  so a guest can guess a surname and see whether it matches; `minPrice`/`maxPrice` can similarly
  bracket the exact price the band hides. Closing it means restricting `q` for anonymous callers
  or rate-limiting probes, and both cost real search usability.
- **No global default-deny auth guard.** Routes are public by *omission* of `@UseGuards`, so a
  new route added without one is exposed by default. Making `@Public()` real means registering
  `JwtAuthGuard` globally and auditing every currently-public route — worth doing, but as its own
  focused change, since missing one silently breaks guest browsing.
- **Crons duplicate if the API is ever scaled past one instance** under
  `SCHEDULER_MODE=in-process`. See "Scheduled work" above.

**Quality:**
- Coverage is ~25% of statements. Controllers, media, availability and notifications remain
  largely untested.
- No integration/e2e tests against a real database. Every wave was verified by hand against local
  Postgres instead, which does not survive as a regression net.
- The two open `postcss` advisories in the frontend can only be closed by Next.js shipping a
  patched copy — see the audit section above, and do not "fix" them with `--force`.
- Revisiting the cookie `SameSite` choice if the frontend and backend ever end up on genuinely
  unrelated domains instead of a shared parent domain.
