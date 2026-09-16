import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { UserRecord } from '../users/users.types';
import {
  CancelBookingDto,
  CreateBookingDto,
  RespondBookingDto,
} from './dto/bookings.dto';

/** The statuses a booking may be cancelled FROM. */
const CANCELLABLE_STATUSES = ['pending', 'accepted'];

/**
 * What a losing compare-and-swap tells the caller.
 *
 * 409 rather than 400: nothing about the request was wrong, it simply
 * arrived second. The client should re-read and show the current state
 * rather than asking the user to correct anything.
 */
const CONCURRENT_CHANGE =
  'This booking was changed by someone else a moment ago. Refresh to see its current status.';

@Injectable()
export class BookingsService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  // ----------------------------------------------------------------
  // Create a booking proposal (planner only)
  // ----------------------------------------------------------------
  async create(planner: UserRecord, dto: CreateBookingDto) {
    if (planner.role !== 'planner') {
      throw new ForbiddenException('Only planners can propose bookings.');
    }

    // Verify artist exists and is active
    const artist = await this.db('users')
      .where({ id: dto.artistId, role: 'artist', status: 'active' })
      .first();
    if (!artist) throw new NotFoundException('Artist not found.');

    // Guard: event date must be in the future
    const today = new Date().toISOString().split('T')[0];
    if (dto.eventDate <= today) {
      throw new BadRequestException('Event date must be in the future.');
    }

    // Guard: artist must not have an availability block on that date
    const blocked = await this.db('availability_blocks')
      .where('artist_id', dto.artistId)
      .where('start_date', '<=', dto.eventDate)
      .where('end_date',   '>=', dto.eventDate)
      .first();
    if (blocked) {
      throw new BadRequestException('Artist is marked unavailable on this date.');
    }

    // Guard: no duplicate pending/accepted booking for the same artist+date
    const conflict = await this.db('bookings')
      .where({ artist_id: dto.artistId, event_date: dto.eventDate })
      .whereIn('status', ['pending', 'accepted'])
      .first();
    if (conflict) {
      throw new BadRequestException('Artist already has a pending or accepted booking on this date.');
    }

    const [booking] = await this.db('bookings')
      .insert({
        artist_id:       dto.artistId,
        planner_id:      planner.id,
        conversation_id: dto.conversationId ?? null,
        event_name:      dto.eventName,
        event_date:      dto.eventDate,
        event_location:  dto.eventLocation ?? null,
        duration_hours:  dto.durationHours ?? null,
        agreed_fee_usd:  dto.agreedFeeUsd  ?? null,
        notes:           dto.notes         ?? null,
        // Planner is already implicitly accepting by creating the booking
        planner_accepted_at: this.db.fn.now(),
      })
      .returning('*');

    // Notify the artist
    await this.notify(dto.artistId, 'booking_request', 'New booking request', {
      booking_id:   booking.id,
      event_name:   booking.event_name,
      event_date:   booking.event_date,
      planner_name: planner.accountCode,
    });

    return booking;
  }

  // ----------------------------------------------------------------
  // Artist responds to a booking proposal
  // ----------------------------------------------------------------
  async respond(artist: UserRecord, bookingId: string, dto: RespondBookingDto) {
    const booking = await this.findAndAssertParticipant(artist.id, bookingId);

    if (booking.artist_id !== artist.id) {
      throw new ForbiddenException('Only the artist can accept or decline a booking.');
    }
    if (booking.status !== 'pending') {
      throw new BadRequestException(`Booking is already ${booking.status}.`);
    }

    // Compare-and-swap, not read-then-write.
    //
    // The status check above is necessary and not sufficient: Accept and
    // Decline fired together both read 'pending', both pass it, and both
    // update — so the last writer wins and the planner receives BOTH
    // notifications, one of which is a lie. Carrying the expected status in
    // the WHERE means the loser updates zero rows and finds out.
    //
    // The pattern already exists in this codebase. subscriptions.activate()
    // does exactly this; this is that, applied here.
    if (dto.decision === 'accepted') {
      const [updated] = await this.db('bookings')
        .where({ id: bookingId, status: 'pending' })
        .update({
          status:             'accepted',
          artist_accepted_at: this.db.fn.now(),
        })
        .returning('*');

      if (!updated) throw new ConflictException(CONCURRENT_CHANGE);

      // Notify planner — only after the swap actually won, so the
      // notification cannot describe a transition that did not happen.
      await this.notify(booking.planner_id, 'booking_accepted', 'Booking accepted', {
        booking_id: bookingId,
        event_name: booking.event_name,
        event_date: booking.event_date,
      });

      return updated;
    } else {
      const [updated] = await this.db('bookings')
        .where({ id: bookingId, status: 'pending' })
        .update({ status: 'declined' })
        .returning('*');

      if (!updated) throw new ConflictException(CONCURRENT_CHANGE);

      await this.notify(booking.planner_id, 'booking_declined', 'Booking declined', {
        booking_id: bookingId,
        event_name: booking.event_name,
        event_date: booking.event_date,
      });

      return updated;
    }
  }

  // ----------------------------------------------------------------
  // Cancel an accepted booking (either party)
  // ----------------------------------------------------------------
  async cancel(user: UserRecord, bookingId: string, dto: CancelBookingDto) {
    const booking = await this.findAndAssertParticipant(user.id, bookingId);

    if (!CANCELLABLE_STATUSES.includes(booking.status)) {
      throw new BadRequestException(`Cannot cancel a booking that is ${booking.status}.`);
    }

    // Same compare-and-swap, and here the read-then-write was worse than a
    // duplicate notification: a cancel racing an accept could write
    // 'cancelled' and then be overwritten back to 'accepted' by the other
    // statement, leaving a booking that both parties believe is cancelled
    // live in the database. whereIn pins the exact set of statuses the
    // check above allowed, so a status that changed underneath us loses.
    const [updated] = await this.db('bookings')
      .where({ id: bookingId })
      .whereIn('status', CANCELLABLE_STATUSES)
      .update({
        status:            'cancelled',
        cancelled_by:      user.id,
        cancelled_at:      this.db.fn.now(),
        cancellation_note: dto.note ?? null,
      })
      .returning('*');

    if (!updated) throw new ConflictException(CONCURRENT_CHANGE);

    // Notify the other party
    const otherPartyId =
      user.id === booking.artist_id ? booking.planner_id : booking.artist_id;

    await this.notify(otherPartyId, 'booking_cancelled', 'Booking cancelled', {
      booking_id: bookingId,
      event_name: booking.event_name,
      event_date: booking.event_date,
    });

    return updated;
  }

  // ----------------------------------------------------------------
  // List own bookings (both roles)
  // ----------------------------------------------------------------
  async listMine(user: UserRecord) {
    const col = user.role === 'artist' ? 'artist_id' : 'planner_id';

    return this.db('bookings as b')
      .where(`b.${col}`, user.id)
      .orderBy('b.event_date', 'desc')
      .select('b.*');
  }

  // ----------------------------------------------------------------
  // Get single booking
  // ----------------------------------------------------------------
  async findOne(userId: string, bookingId: string) {
    return this.findAndAssertParticipant(userId, bookingId);
  }

  // ----------------------------------------------------------------
  // Internal: mark bookings as completed where event_date < today
  // Called by the scheduler, not exposed as an endpoint.
  // ----------------------------------------------------------------
  async markCompletedBatch(): Promise<{ id: string; artist_id: string; planner_id: string; review_emails_sent_at: Date | null }[]> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    const rows = await this.db('bookings')
      .where('status', 'accepted')
      .where('event_date', '<=', dateStr)
      .update({ status: 'completed' })
      .returning(['id', 'artist_id', 'planner_id', 'review_emails_sent_at']);

    return rows;
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------
  private async findAndAssertParticipant(userId: string, bookingId: string) {
    const booking = await this.db('bookings').where({ id: bookingId }).first();
    if (!booking) throw new NotFoundException('Booking not found.');
    if (booking.artist_id !== userId && booking.planner_id !== userId) {
      throw new ForbiddenException('You are not a participant in this booking.');
    }
    return booking;
  }

  private async notify(
    userId:  string,
    type:    string,
    title:   string,
    data:    Record<string, any> = {},
  ) {
    await this.db('notifications').insert({
      user_id: userId,
      type,
      title,
      data: JSON.stringify(data),
    });
  }
}
