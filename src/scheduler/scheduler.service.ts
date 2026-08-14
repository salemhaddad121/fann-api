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

export interface MaintenanceNotification {
  userId: string;
  type: string;
  title: string;
  data: Record<string, unknown>;
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
  ) {}

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
