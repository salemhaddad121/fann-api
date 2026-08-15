import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { ConfigService } from '@nestjs/config';
import { BookingsService } from '../bookings/bookings.service';
import { ReviewsService, REVIEW_WINDOW_DAYS } from '../reviews/reviews.service';
import { EmailService } from '../email/email.service';
import { AnalyticsService, RETENTION_DAYS } from '../analytics/analytics.service';
import {
  REMINDER_NOTIFICATION_TYPE,
  SubscriptionsService,
} from '../subscriptions/subscriptions.service';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry';
import { IdentityDocumentsService } from '../verification/identity-documents.service';

export interface MaintenanceNotification {
  userId: string;
  type: string;
  title: string;
  data: Record<string, unknown>;
}

/**
 * The pooled pg connection, reached through Knex's client.
 *
 * Knex has no public API for "give me one connection and let me keep it",
 * which is what a session-scoped advisory lock requires — so these two
 * methods are typed here rather than cast away at the call site. They have
 * been stable across Knex 2 and 3 and are the documented escape hatch for
 * exactly this case. `query` is node-postgres', not Knex's.
 */
interface PoolConnection {
  query(
    sql: string,
    params: unknown[],
  ): Promise<{ rows?: { acquired?: boolean }[] } | undefined>;
}

interface KnexPoolClient {
  acquireConnection(): Promise<PoolConnection>;
  releaseConnection(conn: PoolConnection): Promise<void>;
}

/**
 * Namespace for every advisory lock this app takes, so a key collision with
 * anything else sharing the database is not possible. Postgres advisory
 * locks are a single global space keyed by two int4s — the first is ours.
 * 0x66616e6e spells "fann" and fits a signed int4.
 */
const CRON_LOCK_NAMESPACE = 0x66616e6e;

/**
 * Stable int4 key for a job name, so every instance derives the same lock
 * from the same string without a registry of hand-assigned numbers.
 *
 * FNV-1a, folded to signed 32-bit because that is what pg_try_advisory_lock
 * takes. Collisions across a handful of job names are not a practical
 * concern, and the cost of one would be two jobs taking turns rather than
 * anything incorrect.
 */
export function cronLockKey(job: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < job.length; i++) {
    hash ^= job.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/**
 * Works out what to tell people after an expiry-and-promotion sweep.
 *
 * When a queued plan is promoted in the same run that ended the previous
 * one, nothing was interrupted — so saying "your subscription ended" and
 * then "your next plan has started" describes a break in service that did
 * not happen, and reads as alarming for what is really a seamless
 * rollover. Those two collapse into a single message.
 *
 * A promotion with no matching expiry still gets its own notification:
 * that is the recovery case, where an earlier run failed to promote and
 * this one caught up, and the user genuinely did lose access in between.
 *
 * Pure on purpose — this is the part worth testing, and it needs no
 * database to do it.
 */
export function buildMaintenanceNotifications(
  expired: { id: string; user_id: string; plan_code: string }[],
  promoted: { id: string; user_id: string; plan_code: string; expires_at: Date }[],
): MaintenanceNotification[] {
  // At most one active subscription per user, so at most one expiry each.
  const pendingPromotions = new Map(promoted.map((p) => [p.user_id, p]));
  const notifications: MaintenanceNotification[] = [];

  for (const ended of expired) {
    const next = pendingPromotions.get(ended.user_id);

    if (!next) {
      notifications.push({
        userId: ended.user_id,
        type: 'subscription_expired',
        title: 'Your subscription ended',
        data: { subscription_id: ended.id, plan_code: ended.plan_code },
      });
      continue;
    }

    pendingPromotions.delete(ended.user_id);
    notifications.push({
      userId: ended.user_id,
      type: 'subscription_rolled_over',
      title: `Your ${ended.plan_code} plan ended and your ${next.plan_code} plan started`,
      data: {
        subscription_id: next.id,
        plan_code: next.plan_code,
        expires_at: next.expires_at,
        previous_subscription_id: ended.id,
        previous_plan_code: ended.plan_code,
      },
    });
  }

  for (const next of pendingPromotions.values()) {
    notifications.push({
      userId: next.user_id,
      type: 'subscription_started',
      title: 'Your next plan has started',
      data: {
        subscription_id: next.id,
        plan_code: next.plan_code,
        expires_at: next.expires_at,
      },
    });
  }

  return notifications;
}

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  // @Cron needs a process that stays alive, which is true in the container
  // and false on Vercel, where each request is a short-lived function. On
  // serverless the same methods are driven over HTTP by Vercel Cron via
  // CronController, and this flag stops both triggers firing at once.
  //
  // Defaults to in-process, so existing deployments keep working untouched.
  private get inProcessCronEnabled(): boolean {
    return (this.configService.get<string>('SCHEDULER_MODE') ?? 'in-process') === 'in-process';
  }

  constructor(
    @InjectConnection() private readonly db: Knex,
    private readonly bookingsService: BookingsService,
    private readonly reviewsService:  ReviewsService,
    private readonly emailService:    EmailService,
    private readonly configService:   ConfigService,
    private readonly analyticsService: AnalyticsService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly providerRegistry: PaymentProviderRegistry,
    private readonly identityDocuments: IdentityDocumentsService,
  ) {}

  /**
   * Runs a job only if no other instance is already running it.
   *
   * Today there is one instance and this never blocks anything. It exists
   * because the failure it prevents is silent and expensive: scale the API
   * to two instances under SCHEDULER_MODE=in-process and every @Cron fires
   * on both at the same moment, which means renewal reminders sent twice,
   * payment intents polled twice, and a queued subscription promoted twice.
   * None of that raises an error — it just quietly happens to real people.
   *
   * Guards the HTTP path too, since the lock sits inside the run* methods
   * that CronController calls rather than on the @Cron wrappers. Vercel Cron
   * firing twice is protected by exactly the same mechanism.
   *
   * Three details that are easy to get wrong:
   *
   *  - The lock is SESSION-scoped (pg_try_advisory_lock), not transaction-
   *    scoped. A transaction-scoped lock would mean wrapping each job in one
   *    long transaction, and these jobs deliberately commit as they go — the
   *    review trigger emails people mid-loop, and rolling that back after
   *    the mail is sent makes a failure worse rather than atomic.
   *
   *  - It is taken on ONE connection held for the whole job. Session locks
   *    belong to a connection, so acquiring on a pooled connection and
   *    releasing on whichever one the pool hands back next would leak the
   *    lock permanently and wedge the job forever.
   *
   *  - try_ rather than the blocking form. An instance that cannot get the
   *    lock should skip this run — the job is on a schedule and will come
   *    round again. Blocking would pile up workers waiting on a job another
   *    instance is already doing.
   */
  private async withCronLock(job: string, work: () => Promise<void>): Promise<void> {
    const pool = (this.db as unknown as { client: KnexPoolClient }).client;
    const key = cronLockKey(job);

    let conn: PoolConnection;
    try {
      conn = await pool.acquireConnection();
    } catch (err) {
      this.logger.error(`[Scheduler] Could not get a connection to lock ${job}`, err);
      return;
    }

    try {
      const result = await conn.query(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [CRON_LOCK_NAMESPACE, key],
      );

      if (result?.rows?.[0]?.acquired !== true) {
        this.logger.log(`[Scheduler] ${job} is already running elsewhere; skipping this run.`);
        return;
      }

      try {
        await work();
      } finally {
        // In a finally so a throwing job cannot strand the lock. The job
        // bodies all catch their own errors, but that is their choice to
        // change, not something this should depend on.
        await conn.query('SELECT pg_advisory_unlock($1, $2)', [CRON_LOCK_NAMESPACE, key]);
      }
    } catch (err) {
      this.logger.error(`[Scheduler] Locking failed for ${job}`, err);
    } finally {
      await pool.releaseConnection(conn);
    }
  }

  // ----------------------------------------------------------------
  // Hourly, not daily. A day pass activated at 14:20 runs out at 14:20 the
  // next day, so a once-a-day sweep would leave a queued plan waiting up to
  // 23 hours before it starts.
  //
  // Access itself is never wrong in the meantime: getActiveSubscription()
  // checks expires_at rather than trusting status, so a lapsed row stops
  // granting access the moment it lapses whether or not this has run. What
  // this job fixes is the bookkeeping and, more importantly, the promotion.
  // ----------------------------------------------------------------
  @Cron(CronExpression.EVERY_HOUR)
  async handleSubscriptionMaintenance() {
    if (!this.inProcessCronEnabled) return;
    await this.runSubscriptionMaintenance();
  }

  async runSubscriptionMaintenance() {
    await this.withCronLock('subscription-maintenance', () =>
      this.doSubscriptionMaintenance(),
    );
  }

  private async doSubscriptionMaintenance() {
    try {
      const { expired, promoted } = await this.subscriptionsService.expireAndPromote();

      if (expired.length > 0) {
        this.logger.log(`[Scheduler] Expired ${expired.length} subscription(s)`);
      }
      if (promoted.length > 0) {
        this.logger.log(`[Scheduler] Promoted ${promoted.length} queued subscription(s)`);
      }

      for (const notification of buildMaintenanceNotifications(expired, promoted)) {
        await this.notifySubscription(
          notification.userId,
          notification.type,
          notification.title,
          notification.data,
        );
      }
    } catch (err) {
      this.logger.error('[Scheduler] Subscription maintenance failed', err);
    }
  }

  // ----------------------------------------------------------------
  // Daily at 08:00 UTC — warn before a plan lapses. Year plans at 30/7/1
  // days, month plans at 3, day passes never (there is no useful warning
  // window inside 24 hours).
  // ----------------------------------------------------------------
  @Cron('0 8 * * *', { timeZone: 'UTC' })
  async handleRenewalReminders() {
    if (!this.inProcessCronEnabled) return;
    await this.runRenewalReminders();
  }

  async runRenewalReminders() {
    await this.withCronLock('renewal-reminders', () => this.doRenewalReminders());
  }

  private async doRenewalReminders() {
    try {
      const due = await this.subscriptionsService.findDueRenewalReminders();
      if (due.length === 0) return;

      const appUrl = this.configService.get<string>('APP_URL');
      const renewUrl = `${appUrl}/plans`;

      for (const reminder of due) {
        const user = await this.db('users as u')
          .leftJoin('planner_profiles as pp', 'pp.user_id', 'u.id')
          .where('u.id', reminder.user_id)
          .select('u.email', 'pp.display_name')
          .first();
        if (!user) continue;

        // The notification is written first and is what deduplicates the
        // next run, so a Resend outage cannot turn into the same warning
        // being re-sent every day.
        await this.notifySubscription(
          reminder.user_id,
          REMINDER_NOTIFICATION_TYPE,
          `Your ${reminder.plan_code} plan ends in ${reminder.days} day(s)`,
          {
            subscription_id: reminder.subscription_id,
            plan_code: reminder.plan_code,
            days: reminder.days,
            expires_at: reminder.expires_at,
          },
        );

        await this.emailService.sendSubscriptionExpiringEmail({
          to: user.email,
          recipientName: user.display_name ?? user.email,
          planCode: reminder.plan_code,
          daysLeft: reminder.days,
          expiresAt: reminder.expires_at,
          renewUrl,
        });
      }

      this.logger.log(`[Scheduler] Sent ${due.length} renewal reminder(s)`);
    } catch (err) {
      this.logger.error('[Scheduler] Renewal reminders failed', err);
    }
  }

  // ----------------------------------------------------------------
  // Every 15 minutes — reconcile payments left hanging with a provider.
  //
  // Two jobs in one pass:
  //
  //  * Poll providers that expose getStatus. This exists because a
  //    reference-matching service may have no webhook at all — if that is
  //    how OMT turns out to work, polling is the primary path and not a
  //    fallback.
  //  * Expire intents past intent_expires_at, so an abandoned checkout
  //    stops sitting in the admin queue forever.
  //
  // Never touches manual payments: those are confirmed by a person, and an
  // automated sweep expiring them would cancel transfers that are simply
  // waiting on an admin.
  // ----------------------------------------------------------------
  @Cron('*/15 * * * *')
  async handlePaymentReconciliation() {
    if (!this.inProcessCronEnabled) return;
    await this.runPaymentReconciliation();
  }

  async runPaymentReconciliation() {
    await this.withCronLock('payment-reconciliation', () =>
      this.doPaymentReconciliation(),
    );
  }

  private async doPaymentReconciliation() {
    try {
      const expired = await this.db('payments')
        .where('status', 'awaiting_provider')
        .whereNot('provider', 'manual')
        .whereNotNull('intent_expires_at')
        .whereRaw('intent_expires_at < now()')
        .update({ status: 'expired', updated_at: this.db.fn.now() })
        .returning(['id']);

      if (expired.length > 0) {
        this.logger.log(`[Scheduler] Expired ${expired.length} stale payment intent(s)`);
      }

      // Only providers that actually implement polling. The rest are
      // webhook-driven and there is nothing to ask them.
      for (const provider of this.providerRegistry.pollable()) {
        if (provider.code === 'manual') continue;

        const stale = await this.db('payments')
          .where('status', 'awaiting_provider')
          .where('provider', provider.code)
          .whereNotNull('provider_ref')
          // 30 minutes, so this never races a webhook that is simply in
          // flight. Polling a payment the provider is about to confirm
          // anyway just doubles the work.
          .whereRaw("created_at < now() - interval '30 minutes'")
          .select('id', 'provider_ref');

        for (const payment of stale) {
          try {
            const status = await provider.getStatus!(payment.provider_ref);
            if (status === 'unknown') continue;

            this.logger.log(
              `[Scheduler] Provider ${provider.code} reports ${status} for payment ${payment.id}`,
            );

            // Deliberately does NOT confirm here. Minting runs through the
            // webhook path so amount and currency are verified against the
            // stored intent — a poll that only reports "paid" carries no
            // amount to check, and granting on that alone would skip the
            // guard against a misrouted or tampered payment.
            if (status === 'failed' || status === 'expired') {
              await this.db('payments')
                .where({ id: payment.id })
                .update({
                  status: status === 'failed' ? 'rejected' : 'expired',
                  updated_at: this.db.fn.now(),
                });
            }
          } catch (err) {
            this.logger.error(
              `[Scheduler] Polling failed for payment ${payment.id}`,
              err,
            );
          }
        }
      }
    } catch (err) {
      this.logger.error('[Scheduler] Payment reconciliation failed', err);
    }
  }

  // ----------------------------------------------------------------
  // Daily at 03:00 UTC — delete identity files past their retention window.
  //
  // Separate from the telemetry prune despite doing a similar job, because
  // the stakes are not comparable: that one drops browsing history, this
  // one deletes government ID. Keeping them apart means a failure in one is
  // visible on its own rather than buried in a shared log line.
  //
  // Early, and after the other jobs, because it talks to object storage
  // rather than just the database — it is the slowest and the most likely
  // to be rate-limited, and nothing else waits on it.
  // ----------------------------------------------------------------
  @Cron('0 3 * * *', { timeZone: 'UTC' })
  async handleIdentityDocumentRetention() {
    if (!this.inProcessCronEnabled) return;
    await this.runIdentityDocumentRetention();
  }

  async runIdentityDocumentRetention() {
    await this.withCronLock('identity-document-retention', () =>
      this.doIdentityDocumentRetention(),
    );
  }

  private async doIdentityDocumentRetention() {
    try {
      const { purged, failed } = await this.identityDocuments.pruneExpiredDocuments();

      if (failed > 0) {
        // Worth surfacing loudly. A file we intended to delete and could
        // not is exactly the thing that quietly persists for years.
        this.logger.error(
          `[Scheduler] Identity retention: ${failed} document(s) could not be purged`,
        );
      } else if (purged > 0) {
        this.logger.log(`[Scheduler] Identity retention: purged ${purged} document(s)`);
      }
    } catch (err) {
      this.logger.error('[Scheduler] Identity document retention failed', err);
    }
  }

  private async notifySubscription(
    userId: string,
    type: string,
    title: string,
    data: Record<string, unknown>,
  ) {
    await this.db('notifications').insert({
      user_id: userId,
      type,
      title,
      data: JSON.stringify(data),
    });
  }

  // ----------------------------------------------------------------
  // Runs every day at 09:00 (Lebanon time, UTC+3 → 06:00 UTC)
  // 1. Mark accepted bookings whose event_date has passed as completed
  // 2. Send review request emails + in-app notifications to both parties
  // 3. Set review_emails_sent_at so the 7-day window starts
  // ----------------------------------------------------------------
  @Cron('0 6 * * *', { timeZone: 'UTC' })
  async handleDailyReviewTrigger() {
    if (!this.inProcessCronEnabled) return;
    await this.runDailyReviewTrigger();
  }

  // The work itself. Called by the cron above in-process, or directly by
  // CronController when Vercel Cron drives it over HTTP — the gate lives on
  // the wrapper only, so the HTTP path is never short-circuited by it.
  async runDailyReviewTrigger() {
    await this.withCronLock('daily-review-trigger', () => this.doDailyReviewTrigger());
  }

  private async doDailyReviewTrigger() {
    this.logger.log('[Scheduler] Daily review trigger started');

    try {
      // Step 1 — mark completed
      const completed = await this.bookingsService.markCompletedBatch();
      this.logger.log(`[Scheduler] Marked ${completed.length} booking(s) as completed`);

      // Step 2 — for each newly completed booking, send review requests
      for (const booking of completed) {
        if (booking.review_emails_sent_at) continue; // already triggered

        await this.sendReviewRequests(booking.id, booking.artist_id, booking.planner_id);
        await this.db('bookings')
          .where({ id: booking.id })
          .update({ review_emails_sent_at: this.db.fn.now() });
      }
    } catch (err) {
      this.logger.error('[Scheduler] Review trigger failed', err);
    }
  }

  // ----------------------------------------------------------------
  // Runs every day at 09:30 UTC — unlock reviews whose 7-day window
  // has expired (one party never submitted).
  // ----------------------------------------------------------------
  @Cron('30 6 * * *', { timeZone: 'UTC' })
  async handleExpiredReviewUnlock() {
    if (!this.inProcessCronEnabled) return;
    await this.runExpiredReviewUnlock();
  }

  async runExpiredReviewUnlock() {
    await this.withCronLock('expired-review-unlock', () => this.doExpiredReviewUnlock());
  }

  private async doExpiredReviewUnlock() {
    this.logger.log('[Scheduler] Expired review unlock started');

    try {
      const unlocked = await this.reviewsService.unlockExpiredReviews();
      this.logger.log(`[Scheduler] Unlocked ${unlocked} review(s) past the ${REVIEW_WINDOW_DAYS}-day window`);
    } catch (err) {
      this.logger.error('[Scheduler] Expired review unlock failed', err);
    }
  }

  // ----------------------------------------------------------------
  // Runs daily at 07:00 UTC — deletes page_events past the retention
  // window. These rows are personal browsing history, so they are not kept
  // indefinitely; the engagement metrics only look back 30 days.
  //
  // Deliberately after the two review jobs so a slow delete cannot delay
  // anything user-facing.
  // ----------------------------------------------------------------
  @Cron('0 7 * * *', { timeZone: 'UTC' })
  async handleDailyTelemetryPrune() {
    if (!this.inProcessCronEnabled) return;
    await this.runTelemetryPrune();
  }

  async runTelemetryPrune() {
    await this.withCronLock('telemetry-prune', () => this.doTelemetryPrune());
  }

  private async doTelemetryPrune() {
    try {
      const deleted = await this.analyticsService.pruneOldEvents();
      if (deleted > 0) {
        this.logger.log(
          `[Scheduler] Pruned ${deleted} page_event(s) older than ${RETENTION_DAYS} days`,
        );
      }
    } catch (err) {
      this.logger.error('[Scheduler] Telemetry prune failed', err);
    }
  }

  // ----------------------------------------------------------------
  // Send review request emails + in-app notifications to both parties
  // ----------------------------------------------------------------
  private async sendReviewRequests(
    bookingId: string,
    artistId:  string,
    plannerId: string,
  ) {
    const booking = await this.db('bookings').where({ id: bookingId }).first();

    const artist = await this.db('users as u')
      .leftJoin('artist_profiles as ap', 'ap.user_id', 'u.id')
      .where('u.id', artistId)
      .select('u.email', 'ap.display_name')
      .first();

    const planner = await this.db('users as u')
      .leftJoin('planner_profiles as pp', 'pp.user_id', 'u.id')
      .where('u.id', plannerId)
      .select('u.email', 'pp.display_name')
      .first();

    if (!booking || !artist || !planner) return;

    const appUrl      = this.configService.get<string>('APP_URL');
    const reviewUrl   = `${appUrl}/reviews/submit?bookingId=${bookingId}`;
    const deadlineDays = REVIEW_WINDOW_DAYS;

    // ── In-app notifications ──
    await this.db('notifications').insert([
      {
        user_id: artistId,
        type:    'review_request',
        title:   'How was your booking?',
        data:    JSON.stringify({ booking_id: bookingId, event_name: booking.event_name }),
      },
      {
        user_id: plannerId,
        type:    'review_request',
        title:   'How was your booking?',
        data:    JSON.stringify({ booking_id: bookingId, event_name: booking.event_name }),
      },
    ]);

    // ── Emails ──
    await this.emailService.sendReviewRequestEmail({
      to:            artist.email,
      recipientName: artist.display_name ?? artist.email,
      eventName:     booking.event_name,
      eventDate:     booking.event_date,
      reviewUrl,
      deadlineDays,
      questions: [
        'How was the planner\'s communication throughout?',
        'Was the planner professional and organised?',
        'Was everything ready on time?',
        'How well was the event organised overall?',
      ],
    });

    await this.emailService.sendReviewRequestEmail({
      to:            planner.email,
      recipientName: planner.display_name ?? planner.email,
      eventName:     booking.event_name,
      eventDate:     booking.event_date,
      reviewUrl,
      deadlineDays,
      questions: [
        'How was the artist\'s communication throughout?',
        'Did the artist behave professionally?',
        'Did the artist arrive and set up on time?',
        'How was the quality of the performance overall?',
      ],
    });

    this.logger.log(`Review request email sent → ${artist.email}`);
    this.logger.log(`Review request email sent → ${planner.email}`);
  }
}
