import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { ConfigService } from '@nestjs/config';
import { BookingsService } from '../bookings/bookings.service';
import { ReviewsService, REVIEW_WINDOW_DAYS } from '../reviews/reviews.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectConnection() private readonly db: Knex,
    private readonly bookingsService: BookingsService,
    private readonly reviewsService:  ReviewsService,
    private readonly emailService:    EmailService,
    private readonly configService:   ConfigService,
  ) {}

  // ----------------------------------------------------------------
  // Runs every day at 09:00 (Lebanon time, UTC+3 → 06:00 UTC)
  // 1. Mark accepted bookings whose event_date has passed as completed
  // 2. Send review request emails + in-app notifications to both parties
  // 3. Set review_emails_sent_at so the 7-day window starts
  // ----------------------------------------------------------------
  @Cron('0 6 * * *', { timeZone: 'UTC' })
  async handleDailyReviewTrigger() {
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
    this.logger.log('[Scheduler] Expired review unlock started');

    try {
      const unlocked = await this.reviewsService.unlockExpiredReviews();
      this.logger.log(`[Scheduler] Unlocked ${unlocked} review(s) past the ${REVIEW_WINDOW_DAYS}-day window`);
    } catch (err) {
      this.logger.error('[Scheduler] Expired review unlock failed', err);
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
