-- =============================================================
-- 014: page_events — engagement telemetry
--
-- Backs the two admin metrics that previously had no data behind them:
-- average time in the app, and average time on the search page, split by
-- role. Nothing in the system recorded a page view or a session before
-- this, so those numbers could not be computed at all.
--
-- Design notes:
--
--  * role is denormalised. Every query here groups by it, and joining
--    users on each aggregate to fetch a value that effectively never
--    changes is wasted work.
--
--  * path stores the NORMALISED route ('/artists/[id]'), never the real
--    URL. Two reasons: raw ids would give unbounded cardinality, and
--    storing which specific artist a booker looked at is a far more
--    sensitive record than "they viewed an artist page". Query strings
--    are stripped client-side for the same reason.
--
--  * duration_ms is FOREGROUND time only — the client accumulates it via
--    the Page Visibility API, so a tab left open overnight does not count
--    as engagement. It is best-effort: a hard browser kill can lose the
--    final segment.
--
--  * Only authenticated users are recorded, since role is the point.
--
-- RETENTION: raw rows are personal browsing history and should not be
-- kept indefinitely. Prune anything older than 90 days:
--     DELETE FROM page_events WHERE occurred_at < now() - interval '90 days';
-- There is no scheduler wired to this yet — see the summary.
--
-- Idempotent: guarded by IF NOT EXISTS.
-- =============================================================

CREATE TABLE IF NOT EXISTS page_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        user_role   NOT NULL,
  path        text        NOT NULL,
  duration_ms integer     NOT NULL CHECK (duration_ms >= 0),
  occurred_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Aggregates always filter by window then group by role, and the search
-- metric adds a path filter on top.
CREATE INDEX IF NOT EXISTS idx_page_events_occurred_role
  ON page_events (occurred_at DESC, role);

CREATE INDEX IF NOT EXISTS idx_page_events_path
  ON page_events (path, occurred_at DESC);

-- Supports both the per-user-per-day rollup and the retention delete.
CREATE INDEX IF NOT EXISTS idx_page_events_user_occurred
  ON page_events (user_id, occurred_at DESC);
