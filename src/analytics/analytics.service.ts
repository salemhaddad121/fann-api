import { Injectable } from '@nestjs/common';
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

@Injectable()
export class AnalyticsService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  // role comes from the authenticated user rather than the payload, so a
  // client cannot attribute its activity to the other side of the
  // marketplace.
  async recordPageEvents(userId: string, role: string, dto: RecordPageEventsDto) {
    const rows = dto.events
      // A zero-length view is a route that was passed through, not read.
      .filter((e) => e.durationMs > 0)
      .map((e) => ({
        user_id: userId,
        role,
        path: e.path,
        duration_ms: e.durationMs,
        occurred_at: new Date(e.occurredAt),
      }));

    if (rows.length) await this.db('page_events').insert(rows);
    return { recorded: rows.length };
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
  async pruneOldEvents(retentionDays = RETENTION_DAYS): Promise<number> {
    return this.db('page_events')
      .where('occurred_at', '<', this.db.raw(`now() - interval '${retentionDays} days'`))
      .del();
  }

  async getEngagement() {
    const [overall, search] = await Promise.all([
      this.avgMsPerActiveDay(),
      this.avgMsPerActiveDay('/search'),
    ]);

    return { windowDays: WINDOW_DAYS, overall, search };
  }
}
