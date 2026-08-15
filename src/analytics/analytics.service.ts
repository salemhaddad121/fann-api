import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { RecordPageEventsDto } from './dto/analytics.dto';

// Window used by the admin engagement figures. Long enough to smooth out
// quiet days, short enough that a metric still reacts to a change.
const WINDOW_DAYS = 30;

// Raw rows are personal browsing history, so they are not kept
// indefinitely. Comfortably longer than the reporting window above, so
// pruning can never eat data a metric still needs.
export const RETENTION_DAYS = 90;

// Rows deleted per statement by the prune. Small enough that one statement
// is short and takes few locks, large enough that a normal night's backlog
// clears in a handful of round trips.
export const PRUNE_BATCH_SIZE = 5_000;

// Wall-clock budget for one prune run. The job runs on Vercel under
// SCHEDULER_MODE=http, where a function that overruns is killed mid-flight,
// so the run stops itself well before that rather than being cut off.
// Whatever is left is simply pruned on the next run — see pruneTable().
export const PRUNE_TIME_BUDGET_MS = 30_000;

/**
 * Knex types an aggregate query by its aggregate keys alone and discards the
 * plainly selected columns, so `r.path` on a query that also counts is a
 * type error even though the column is right there in the SELECT. Reading
 * those rows through one permissive record avoids a differently-shaped
 * inline cast at every call site; the values are converted explicitly on the
 * way out regardless.
 */
type AggregateRow = Record<string, unknown>;

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(@InjectConnection() private readonly db: Knex) {}

  // user_id and role come from the session rather than the payload, so a
  // client cannot attribute its activity to the other side of the
  // marketplace. Both are null for a guest, and is_guest is derived here
  // rather than trusted from the body for the same reason.
  async recordPageEvents(
    viewer: { userId?: string; role?: string },
    dto: RecordPageEventsDto,
  ) {
    const isGuest = !viewer.userId;

    const rows = dto.events
      // A zero-length view is a route that was passed through, not read.
      .filter((e) => e.durationMs > 0)
      .map((e) => ({
        user_id: viewer.userId ?? null,
        role: viewer.role ?? null,
        is_guest: isGuest,
        session_id: dto.sessionId ?? null,
        path: e.path,
        duration_ms: e.durationMs,
        occurred_at: new Date(e.occurredAt),
      }));

    if (rows.length) await this.db('page_events').insert(rows);
    return { recorded: rows.length };
  }

  /**
   * Records an executed search.
   *
   * Called from the search handler, not posted by the client. A
   * client-reported count is trivially inflated by anyone with devtools,
   * and these numbers are meant to answer "which categories should we
   * recruit for?" — a question that is worse than useless if the data can
   * be gamed.
   *
   * Never throws. Telemetry failing must not turn a working search into a
   * 500; the row is lost and that is the correct trade.
   */
  async recordSearch(input: {
    userId?: string;
    sessionId?: string;
    categoryId?: string;
    queryText?: string;
    resultCount?: number;
  }): Promise<void> {
    try {
      await this.db('search_events').insert({
        user_id: input.userId ?? null,
        is_guest: !input.userId,
        session_id: input.sessionId ?? null,
        category_id: input.categoryId ?? null,
        query_text: input.queryText?.slice(0, 200) ?? null,
        result_count: input.resultCount ?? null,
      });
    } catch (err) {
      this.logger.warn(`[Analytics] Failed to record search event: ${String(err)}`);
    }
  }

  // "Average time in the app" is deliberately average time per ACTIVE DAY
  // per user, not a lifetime total and not a per-session figure.
  //
  // A lifetime total just rewards whoever signed up earliest. A per-session
  // number needs a session concept that does not exist and would need
  // inactivity-gap heuristics to invent. Per active day answers the
  // question actually being asked — "when an artist uses Fann, how long do
  // they spend?" — from data we genuinely have.
  //
  // Users with no activity in the window are excluded rather than counted
  // as zero: this measures engagement of people who showed up, not
  // retention. Reading it as retention would be wrong.
  private async avgMsPerActiveDay(pathFilter?: string) {
    const inner = this.db('page_events')
      .select('user_id', 'role')
      .select(this.db.raw('occurred_at::date AS day'))
      .sum({ daily_ms: 'duration_ms' })
      .where('occurred_at', '>=', this.db.raw(`now() - interval '${WINDOW_DAYS} days'`))
      .groupBy('user_id', 'role', this.db.raw('occurred_at::date'));

    if (pathFilter) inner.where('path', pathFilter);

    const rows = await this.db
      .select('role')
      .avg({ avg_ms: 'daily_ms' })
      .countDistinct({ users: 'user_id' })
      .from(inner.as('per_user_day'))
      .groupBy('role');

    return rows.map((r) => ({
      role: r.role as string,
      avgMsPerActiveDay: Math.round(Number(r.avg_ms) || 0),
      users: Number(r.users) || 0,
    }));
  }

  // Deletes raw events past the retention window. Called from the daily
  // scheduler — see SchedulerService.handleDailyTelemetryPrune.
  //
  // Nothing is aggregated into a rollup first, so pruning genuinely loses
  // the old detail. That is the intent: the metrics only ever look back
  // WINDOW_DAYS, and keeping a year of per-page browsing history to serve a
  // 30-day average would be collecting more than the feature needs.
  //
  // search_events is pruned on the same schedule and for a stronger reason:
  // query_text is free text a person typed, and a good share of those rows
  // now belong to guests who never agreed to anything beyond visiting the
  // site. Retention is the only control standing behind that data.
  async pruneOldEvents(retentionDays = RETENTION_DAYS): Promise<number> {
    const deadline = Date.now() + PRUNE_TIME_BUDGET_MS;

    // Sequential, not Promise.all. The two tables share one time budget, and
    // running them concurrently would have each measure its own progress
    // against a clock the other is also spending.
    const pageEvents = await this.pruneTable('page_events', retentionDays, deadline);
    const searchEvents = await this.pruneTable('search_events', retentionDays, deadline);

    return pageEvents + searchEvents;
  }

  /**
   * Deletes one table's expired rows in batches.
   *
   * The single unbounded `DELETE ... WHERE occurred_at < cutoff` this
   * replaces was correct but could not last: both tables only grow, so the
   * statement's cost grows with them, and it is the one job with no ceiling
   * on how long it can run. Raising the function timeout would have bought
   * time and not fixed anything.
   *
   * Batching changes the failure mode rather than just deferring it. Each
   * batch is its own autocommitted statement, so a run that is cut off
   * halfway keeps everything it already deleted and the next run resumes
   * from there. The old version did all its work in one statement: killed at
   * any point, it rolled back entirely and the backlog was strictly worse
   * the following night.
   *
   * `LIMIT` cannot be applied to DELETE directly in Postgres, hence the
   * subquery on the primary key.
   */
  private async pruneTable(
    table: 'page_events' | 'search_events',
    retentionDays: number,
    deadline: number,
  ): Promise<number> {
    let total = 0;

    for (;;) {
      const expired = this.db(table)
        .select('id')
        .where(
          'occurred_at',
          '<',
          this.db.raw(`now() - interval '${retentionDays} days'`),
        )
        .limit(PRUNE_BATCH_SIZE);

      const deleted = Number(await this.db(table).whereIn('id', expired).del()) || 0;
      total += deleted;

      // A short batch means the cutoff has been reached — nothing left.
      if (deleted < PRUNE_BATCH_SIZE) break;

      if (Date.now() >= deadline) {
        // Not an error. Reported so that a table needing repeated runs to
        // catch up is visible rather than looking like a clean sweep.
        this.logger.warn(
          `[Retention] ${table}: stopped at ${total} row(s) after exhausting the ` +
            `${PRUNE_TIME_BUDGET_MS}ms budget; the remainder prunes on the next run.`,
        );
        break;
      }
    }

    return total;
  }

  async getEngagement() {
    const [overall, search] = await Promise.all([
      this.avgMsPerActiveDay(),
      this.avgMsPerActiveDay('/search'),
    ]);

    return { windowDays: WINDOW_DAYS, overall, search };
  }

  // ----------------------------------------------------------------
  // Session duration
  // ----------------------------------------------------------------

  /**
   * min / max / average / median session length, split by guest vs
   * authenticated.
   *
   * Single-event sessions are discarded. A session with one page view has
   * no measurable duration — the clock starts and stops on the same page —
   * and bounces are common enough that leaving them in drags the average
   * down toward zero and makes the figure describe bounce rate rather than
   * engagement. They are counted separately so the number is not silently
   * hiding them.
   *
   * Median comes from percentile_cont, not from sorting in Node: the point
   * of a median here is resistance to the one session someone left open
   * over lunch, and computing it in the database keeps the whole thing one
   * query regardless of volume.
   */
  async getSessionDurations(from?: string, to?: string) {
    const sessions = this.db('page_events')
      .select('session_id', 'is_guest')
      .sum({ total_ms: 'duration_ms' })
      .count({ event_count: 'id' })
      .whereNotNull('session_id')
      .groupBy('session_id', 'is_guest');

    applyWindow(sessions, from, to);

    const rows = await this.db
      .select('is_guest')
      .count({ sessions: 'session_id' })
      .min({ min_ms: 'total_ms' })
      .max({ max_ms: 'total_ms' })
      .avg({ avg_ms: 'total_ms' })
      .select(
        this.db.raw(
          'percentile_cont(0.5) WITHIN GROUP (ORDER BY total_ms) AS median_ms',
        ),
      )
      .from(sessions.as('per_session'))
      .where('event_count', '>', 1)
      .groupBy('is_guest');

    const discarded = await this.db
      .count({ single_event_sessions: 'session_id' })
      .from(sessions.clone().as('per_session_all'))
      .where('event_count', '=', 1)
      .first();

    return {
      bySegment: rows.map((r) => ({
        segment: r.is_guest ? 'guest' : 'authenticated',
        sessions: Number(r.sessions) || 0,
        minMs: Number(r.min_ms) || 0,
        maxMs: Number(r.max_ms) || 0,
        avgMs: Math.round(Number(r.avg_ms) || 0),
        medianMs: Math.round(Number(r.median_ms) || 0),
      })),
      discardedSingleEventSessions: Number(
        discarded?.single_event_sessions ?? 0,
      ),
    };
  }

  // ----------------------------------------------------------------
  // Time per page
  // ----------------------------------------------------------------

  /**
   * Average and total foreground time per normalised route, ranked.
   *
   * Ranked by total rather than average deliberately: a route visited once
   * for nine minutes would otherwise top a list meant to show where
   * attention actually goes. Both numbers are returned so the other reading
   * is still available.
   */
  async getTimePerPage(from?: string, to?: string) {
    const query = this.db('page_events')
      .select('path', 'is_guest')
      .count({ views: 'id' })
      .sum({ total_ms: 'duration_ms' })
      .avg({ avg_ms: 'duration_ms' })
      .groupBy('path', 'is_guest')
      .orderBy('total_ms', 'desc')
      .limit(100);

    applyWindow(query, from, to);

    // Knex's aggregate helpers replace the inferred row type with only the
    // aggregate keys, dropping the plain selected columns. The cast restores
    // what the query actually returns.
    const rows = (await query) as AggregateRow[];
    return rows.map((r) => ({
      path: r.path as string,
      segment: r.is_guest ? 'guest' : 'authenticated',
      views: Number(r.views) || 0,
      totalMs: Number(r.total_ms) || 0,
      avgMs: Math.round(Number(r.avg_ms) || 0),
    }));
  }

  // ----------------------------------------------------------------
  // Category demand
  // ----------------------------------------------------------------

  /**
   * Which categories people search for, ranked, with absolute counts.
   *
   * Absolute counts rather than percentages: the question behind this is
   * "which categories should we recruit artists for?", and a share of
   * traffic cannot answer it without knowing the total. A category with 12
   * searches and one that has 1,200 both read as "8%" once normalised.
   *
   * Searches with no category filter are reported under a null category
   * rather than dropped — an unfiltered search is still demand, and losing
   * it would overstate how targeted the traffic is.
   */
  async getCategoryDemand(from?: string, to?: string) {
    const query = this.db('search_events as se')
      .leftJoin('categories as c', 'c.id', 'se.category_id')
      .select('c.id', 'c.name', 'c.slug', 'se.is_guest')
      .count({ searches: 'se.id' })
      .avg({ avg_results: 'se.result_count' })
      .groupBy('c.id', 'c.name', 'c.slug', 'se.is_guest')
      .orderBy('searches', 'desc')
      .limit(100);

    applyWindow(query, from, to, 'se.occurred_at');

    const rows = (await query) as AggregateRow[];
    return rows.map((r) => ({
      categoryId: (r.id as string) ?? null,
      category: (r.name as string) ?? 'No category filter',
      slug: (r.slug as string) ?? null,
      segment: r.is_guest ? 'guest' : 'authenticated',
      searches: Number(r.searches) || 0,
      // Persistently low result counts are the actionable signal here:
      // demand the roster cannot currently satisfy.
      avgResults: Math.round(Number(r.avg_results) || 0),
    }));
  }

  /** Top raw search terms. Useful for spotting demand no category covers. */
  async getTopSearchTerms(from?: string, to?: string) {
    const query = this.db('search_events')
      .select('query_text')
      .count({ searches: 'id' })
      .whereNotNull('query_text')
      .whereRaw("btrim(query_text) <> ''")
      .groupBy('query_text')
      .orderBy('searches', 'desc')
      .limit(50);

    applyWindow(query, from, to);

    const rows = (await query) as AggregateRow[];
    return rows.map((r) => ({
      term: r.query_text as string,
      searches: Number(r.searches) || 0,
    }));
  }

  /** Headline guest-vs-authenticated split across both event tables. */
  async getAudienceSplit(from?: string, to?: string) {
    const pageQuery = this.db('page_events')
      .select('is_guest')
      .count({ events: 'id' })
      .countDistinct({ sessions: 'session_id' })
      .groupBy('is_guest');
    applyWindow(pageQuery, from, to);

    const searchQuery = this.db('search_events')
      .select('is_guest')
      .count({ searches: 'id' })
      .groupBy('is_guest');
    applyWindow(searchQuery, from, to);

    const [pageRows, searchRows] = (await Promise.all([pageQuery, searchQuery])) as [
      AggregateRow[],
      AggregateRow[],
    ];

    const segment = (isGuest: unknown) => (isGuest ? 'guest' : 'authenticated');

    return {
      pageViews: pageRows.map((r) => ({
        segment: segment(r.is_guest),
        events: Number(r.events) || 0,
        sessions: Number(r.sessions) || 0,
      })),
      searches: searchRows.map((r) => ({
        segment: segment(r.is_guest),
        searches: Number(r.searches) || 0,
      })),
    };
  }
}

/**
 * Applies an optional reporting window.
 *
 * Both bounds are optional and independent, so the admin screen can ask for
 * "everything since March" without inventing an end date. `to` is treated
 * as inclusive of that whole day — an admin entering the same date in both
 * boxes means "that day", not an empty range.
 */
function applyWindow(
  query: Knex.QueryBuilder,
  from?: string,
  to?: string,
  column = 'occurred_at',
) {
  if (from) query.where(column, '>=', new Date(from));
  if (to) query.where(column, '<', new Date(new Date(to).getTime() + 86_400_000));
  return query;
}
