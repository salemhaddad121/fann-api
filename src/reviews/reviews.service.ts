import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { aggregateValue } from '../common/db.util';
import { UserRecord } from '../users/users.types';
import { SubmitReviewDto } from './dto/reviews.dto';

// How many days after review emails are sent before a submitted
// review is made visible regardless of whether the other party reviewed.
export const REVIEW_WINDOW_DAYS = 7;

@Injectable()
export class ReviewsService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  // ----------------------------------------------------------------
  // Submit a review
  // ----------------------------------------------------------------
  async submit(reviewer: UserRecord, dto: SubmitReviewDto) {
    const booking = await this.db('bookings').where({ id: dto.bookingId }).first();
    if (!booking) throw new NotFoundException('Booking not found.');
    if (booking.status !== 'completed') {
      throw new BadRequestException('Reviews can only be submitted for completed bookings.');
    }

    // Must be a participant
    const isArtist  = booking.artist_id  === reviewer.id;
    const isPlanner = booking.planner_id === reviewer.id;
    if (!isArtist && !isPlanner) {
      throw new ForbiddenException('You are not a participant in this booking.');
    }

    // Enforce the 7-day window from when review emails were sent
    if (booking.review_emails_sent_at) {
      const deadline = new Date(booking.review_emails_sent_at);
      deadline.setDate(deadline.getDate() + REVIEW_WINDOW_DAYS);
      if (new Date() > deadline) {
        throw new BadRequestException('The 7-day review window for this booking has closed.');
      }
    }

    // One review per person per booking (enforced by UNIQUE constraint too)
    const existing = await this.db('reviews')
      .where({ booking_id: dto.bookingId, reviewer_id: reviewer.id })
      .first();
    if (existing) throw new BadRequestException('You have already submitted a review for this booking.');

    const revieweeId    = isArtist ? booking.planner_id : booking.artist_id;
    const reviewerRole  = isArtist ? 'artist' : 'planner';

    const [review] = await this.db('reviews')
      .insert({
        booking_id:            dto.bookingId,
        reviewer_id:           reviewer.id,
        reviewee_id:           revieweeId,
        reviewer_role:         reviewerRole,
        overall_score:         dto.overallScore,
        score_communication:   dto.scoreCommunication,
        score_professionalism: dto.scoreProfessionalism,
        score_punctuality:     dto.scorePunctuality,
        score_quality:         dto.scoreQuality,
        body:                  dto.body ?? null,
        is_visible:            false,   // always starts hidden
      })
      .returning('*');

    // Check if the other party has also submitted — if so, unlock both immediately
    await this.tryUnlockPair(dto.bookingId);

    return {
      ...review,
      message: 'Review submitted. It will be published once the other party also reviews, or after 7 days.',
    };
  }

  // ----------------------------------------------------------------
  // Get visible reviews for an artist profile
  // ----------------------------------------------------------------
  async getForArtist(artistUserId: string) {
    return this.db('reviews as r')
      .join('users as reviewer',       'reviewer.id', 'r.reviewer_id')
      .leftJoin('planner_profiles as pp', 'pp.user_id', 'reviewer.id')
      .where('r.reviewee_id', artistUserId)
      .where('r.reviewer_role', 'planner')  // planners reviewing artists
      .where('r.is_visible', true)
      .orderBy('r.submitted_at', 'desc')
      .select(
        'r.id',
        'r.overall_score',
        'r.score_communication',
        'r.score_professionalism',
        'r.score_punctuality',
        'r.score_quality',
        'r.body',
        'r.submitted_at',
        'pp.display_name as reviewer_display_name',
        'pp.thumbnail_url as reviewer_thumbnail_url',
      );
  }

  // ----------------------------------------------------------------
  // Get visible reviews for a planner profile
  // ----------------------------------------------------------------
  async getForPlanner(plannerUserId: string) {
    return this.db('reviews as r')
      .join('users as reviewer',       'reviewer.id', 'r.reviewer_id')
      .leftJoin('artist_profiles as ap', 'ap.user_id', 'reviewer.id')
      .where('r.reviewee_id', plannerUserId)
      .where('r.reviewer_role', 'artist')  // artists reviewing planners
      .where('r.is_visible', true)
      .orderBy('r.submitted_at', 'desc')
      .select(
        'r.id',
        'r.overall_score',
        'r.score_communication',
        'r.score_professionalism',
        'r.score_punctuality',
        'r.score_quality',
        'r.body',
        'r.submitted_at',
        'ap.display_name as reviewer_display_name',
        'ap.thumbnail_url as reviewer_thumbnail_url',
      );
  }

  // ----------------------------------------------------------------
  // Unlock reviews where the 7-day window has expired
  // Called daily by the scheduler.
  // ----------------------------------------------------------------
  async unlockExpiredReviews(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - REVIEW_WINDOW_DAYS);

    // Find completed bookings whose review window has expired
    // and that still have at least one hidden review
    const expiredBookings = await this.db('bookings as b')
      .join('reviews as r', 'r.booking_id', 'b.id')
      .where('b.status', 'completed')
      .where('b.review_emails_sent_at', '<=', cutoff.toISOString())
      .where('r.is_visible', false)
      .pluck('b.id') // just the booking IDs
      .distinct();

    if (expiredBookings.length === 0) return 0;

    // Unlock all hidden reviews for these bookings
    const count = await this.db('reviews')
      .whereIn('booking_id', expiredBookings)
      .where('is_visible', false)
      .update({ is_visible: true });

    // Recalculate aggregates for all affected reviewees
    const affectedReviewees = await this.db('reviews')
      .whereIn('booking_id', expiredBookings)
      .pluck('reviewee_id')
      .distinct();

    for (const revieweeId of affectedReviewees) {
      await this.recalculateAggregate(revieweeId);
    }

    return count;
  }

  // ----------------------------------------------------------------
  // Admin: remove a review (soft removal — just hides it)
  // ----------------------------------------------------------------
  async adminRemove(reviewId: string) {
    const review = await this.db('reviews').where({ id: reviewId }).first();
    if (!review) throw new NotFoundException('Review not found.');

    await this.db('reviews').where({ id: reviewId }).update({ is_visible: false });

    // Recalculate the reviewee's aggregate
    await this.recalculateAggregate(review.reviewee_id);

    return { message: 'Review removed.' };
  }

  // ----------------------------------------------------------------
  // Admin: list all reviews (for moderation queue)
  // ----------------------------------------------------------------
  async adminList(page = 1, limit = 30) {
    const offset = (page - 1) * limit;

    const [rows, countRow] = await Promise.all([
      this.db('reviews as r')
        .join('users as reviewer', 'reviewer.id', 'r.reviewer_id')
        .join('users as reviewee', 'reviewee.id', 'r.reviewee_id')
        .join('bookings as b',    'b.id', 'r.booking_id')
        .select(
          'r.*',
          'reviewer.email as reviewer_email',
          'reviewee.email as reviewee_email',
          'b.event_name',
          'b.event_date',
        )
        .orderBy('r.submitted_at', 'desc')
        .limit(limit)
        .offset(offset),
      this.db('reviews').count('id as total').first(),
    ]);
    const total = aggregateValue(countRow, 'total');

    return {
      data: rows,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  // ----------------------------------------------------------------
  // Internal: unlock both reviews if both parties have submitted
  // ----------------------------------------------------------------
  async tryUnlockPair(bookingId: string) {
    const reviews = await this.db('reviews')
      .where({ booking_id: bookingId })
      .select('id', 'reviewee_id', 'is_visible');

    // Both reviews exist → unlock both
    if (reviews.length === 2) {
      await this.db('reviews')
        .where({ booking_id: bookingId })
        .update({ is_visible: true });

      // Recalculate aggregate for both reviewees
      for (const r of reviews) {
        await this.recalculateAggregate(r.reviewee_id);
      }
    }
  }

  // ----------------------------------------------------------------
  // Recalculate avg_rating and review_count on the profile table
  // ----------------------------------------------------------------
  async recalculateAggregate(userId: string) {
    const { avg, count } = await this.db('reviews')
      .where({ reviewee_id: userId, is_visible: true })
      .select(
        this.db.raw('ROUND(AVG(overall_score)::NUMERIC, 2) as avg'),
        this.db.raw('COUNT(id) as count'),
      )
      .first();

    const patch = {
      avg_rating:   avg   ? Number(avg)   : null,
      review_count: count ? Number(count) : 0,
    };

    // Update whichever profile table applies
    await this.db('artist_profiles').where({ user_id: userId }).update(patch);
    await this.db('planner_profiles').where({ user_id: userId }).update(patch);
  }
}
