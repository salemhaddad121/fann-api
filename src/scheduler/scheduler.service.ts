import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { ConfigService } from '@nestjs/config';
import { BookingsService } from '../bookings/bookings.service';
import { ReviewsService, REVIEW_WINDOW_DAYS } from '../reviews/reviews.service';
import { EmailService } from '../email/email.service';
import { AnalyticsService, RETENTION_DAYS } from '../analytics/analytics.service';

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
  ) {}

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
