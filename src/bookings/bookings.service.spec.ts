import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';
import { UserRecord } from '../users/users.types';

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    email: 'test@example.com',
    phone: null,
    passwordHash: 'hash',
    role: 'artist',
    status: 'active',
    accountCode: 'ART-001',
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    createdAt: new Date(),
    deletedAt: null,
    pendingEmail: null,
    ...overrides,
  };
}

describe('BookingsService', () => {
  describe('respond()', () => {
    it('rejects responding to a booking that is not pending', async () => {
      const bookings = createMockQueryBuilder();
      bookings.first.mockResolvedValueOnce({
        id: 'booking-1',
        artist_id: 'user-1',
        planner_id: 'planner-1',
        status: 'accepted', // already responded to
      });
      const db = createMockDb({ bookings });
      const service = new BookingsService(db);

      await expect(
        service.respond(makeUser({ id: 'user-1' }), 'booking-1', { decision: 'accepted' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when the responding user is not the booking artist', async () => {
      const bookings = createMockQueryBuilder();
      bookings.first.mockResolvedValueOnce({
        id: 'booking-1',
        artist_id: 'someone-else',
        planner_id: 'planner-1',
        status: 'pending',
      });
      const db = createMockDb({ bookings });
      const service = new BookingsService(db);

      await expect(
        service.respond(makeUser({ id: 'user-1' }), 'booking-1', { decision: 'accepted' } as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('accepts a pending booking and notifies the planner', async () => {
      const bookings = createMockQueryBuilder();
      bookings.first.mockResolvedValueOnce({
        id: 'booking-1',
        artist_id: 'user-1',
        planner_id: 'planner-1',
        status: 'pending',
        event_name: 'Wedding',
        event_date: '2026-12-01',
      });
      bookings.returning.mockResolvedValueOnce([{ id: 'booking-1', status: 'accepted' }]);
      const notifications = createMockQueryBuilder();
      const db = createMockDb({ bookings, notifications });
      const service = new BookingsService(db);

      const result = await service.respond(
        makeUser({ id: 'user-1' }),
        'booking-1',
        { decision: 'accepted' } as any,
      );

      expect(result.status).toBe('accepted');
      expect(notifications.insert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'planner-1', type: 'booking_accepted' }),
      );
    });

    it('throws NotFoundException for a booking that does not exist', async () => {
      const bookings = createMockQueryBuilder();
      bookings.first.mockResolvedValueOnce(undefined);
      const db = createMockDb({ bookings });
      const service = new BookingsService(db);

      await expect(
        service.respond(makeUser({ id: 'user-1' }), 'missing-booking', { decision: 'accepted' } as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('cancel()', () => {
    it.each(['declined', 'cancelled', 'completed'])(
      'rejects cancelling a booking that is already %s',
      async (status) => {
        const bookings = createMockQueryBuilder();
        bookings.first.mockResolvedValueOnce({
          id: 'booking-1',
          artist_id: 'user-1',
          planner_id: 'planner-1',
          status,
        });
        const db = createMockDb({ bookings });
        const service = new BookingsService(db);

        await expect(
          service.cancel(makeUser({ id: 'user-1' }), 'booking-1', {} as any),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('rejects a participant not part of the booking', async () => {
      const bookings = createMockQueryBuilder();
      bookings.first.mockResolvedValueOnce({
        id: 'booking-1',
        artist_id: 'someone-else',
        planner_id: 'someone-else-too',
        status: 'pending',
      });
      const db = createMockDb({ bookings });
      const service = new BookingsService(db);

      await expect(
        service.cancel(makeUser({ id: 'user-1' }), 'booking-1', {} as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows cancelling a pending booking and notifies the other party', async () => {
      const bookings = createMockQueryBuilder();
      bookings.first.mockResolvedValueOnce({
        id: 'booking-1',
        artist_id: 'user-1',
        planner_id: 'planner-1',
        status: 'pending',
        event_name: 'Wedding',
        event_date: '2026-12-01',
      });
      bookings.returning.mockResolvedValueOnce([{ id: 'booking-1', status: 'cancelled' }]);
      const notifications = createMockQueryBuilder();
      const db = createMockDb({ bookings, notifications });
      const service = new BookingsService(db);

      const result = await service.cancel(makeUser({ id: 'user-1' }), 'booking-1', {
        note: 'Change of plans',
      } as any);

      expect(result.status).toBe('cancelled');
      // Cancelling artist notifies the planner, not themselves.
      expect(notifications.insert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'planner-1', type: 'booking_cancelled' }),
      );
    });
  });
});


// ----------------------------------------------------------------
// M13 — respond() and cancel() were read-then-write, not
// compare-and-swap. Both read, checked status, then updated WITHOUT
// carrying that status in the WHERE clause.
//
// Accept and Decline fired together both pass the check and the last
// writer wins — and the planner receives BOTH notifications, one of which
// is a lie. Worse, a cancel racing a respond could write 'cancelled' and
// then be overwritten back to 'accepted', leaving a booking both parties
// believe is cancelled live in the database.
//
// The correct pattern already existed here: subscriptions.activate() is a
// proper compare-and-swap. This is that, applied to bookings.
// ----------------------------------------------------------------
describe('BookingsService — concurrent decisions', () => {
  function pendingBooking(overrides: Record<string, unknown> = {}) {
    return {
      id: 'booking-1',
      artist_id: 'artist-1',
      planner_id: 'planner-1',
      status: 'pending',
      event_name: 'Wedding',
      event_date: '2026-12-01',
      ...overrides,
    };
  }

  /** A db whose UPDATE matches nothing — the loser of a race. */
  function raceLost(booking: Record<string, unknown>) {
    const bookings = createMockQueryBuilder();
    bookings.first.mockResolvedValue(booking);
    bookings.returning.mockResolvedValue([]); // zero rows updated
    return { db: createMockDb({ bookings }), bookings };
  }

  /** A db whose UPDATE matches — the winner. */
  function raceWon(booking: Record<string, unknown>, result: Record<string, unknown>) {
    const bookings = createMockQueryBuilder();
    bookings.first.mockResolvedValue(booking);
    bookings.returning.mockResolvedValue([result]);
    return { db: createMockDb({ bookings }), bookings };
  }

  describe('respond()', () => {
    it('carries the expected status in the WHERE clause', async () => {
      const { db, bookings } = raceWon(pendingBooking(), {
        id: 'booking-1',
        status: 'accepted',
      });
      const service = new BookingsService(db);

      await service.respond(makeUser({ id: 'artist-1' }), 'booking-1', {
        decision: 'accepted',
      } as any);

      expect(bookings.where).toHaveBeenCalledWith({ id: 'booking-1', status: 'pending' });
    });

    it('409s the loser of an Accept/Decline race rather than letting it win', async () => {
      const { db } = raceLost(pendingBooking());
      const service = new BookingsService(db);

      await expect(
        service.respond(makeUser({ id: 'artist-1' }), 'booking-1', {
          decision: 'declined',
        } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sends no notification when the swap lost', async () => {
      // The planner used to receive BOTH "accepted" and "declined".
      const bookings = createMockQueryBuilder();
      bookings.first.mockResolvedValue(pendingBooking());
      bookings.returning.mockResolvedValue([]);
      const notifications = createMockQueryBuilder();
      const db = createMockDb({ bookings, notifications });
      const service = new BookingsService(db);

      await service
        .respond(makeUser({ id: 'artist-1' }), 'booking-1', { decision: 'accepted' } as any)
        .catch(() => undefined);

      expect(notifications.insert).not.toHaveBeenCalled();
    });

    it('still notifies the planner when the swap won', async () => {
      const bookings = createMockQueryBuilder();
      bookings.first.mockResolvedValue(pendingBooking());
      bookings.returning.mockResolvedValue([{ id: 'booking-1', status: 'accepted' }]);
      const notifications = createMockQueryBuilder();
      const db = createMockDb({ bookings, notifications });
      const service = new BookingsService(db);

      await service.respond(makeUser({ id: 'artist-1' }), 'booking-1', {
        decision: 'accepted',
      } as any);

      expect(notifications.insert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'planner-1', type: 'booking_accepted' }),
      );
    });
  });

  describe('cancel()', () => {
    it('pins the cancellable statuses in the WHERE clause', async () => {
      const { db, bookings } = raceWon(pendingBooking({ status: 'accepted' }), {
        id: 'booking-1',
        status: 'cancelled',
      });
      const service = new BookingsService(db);

      await service.cancel(makeUser({ id: 'artist-1' }), 'booking-1', {} as any);

      expect(bookings.whereIn).toHaveBeenCalledWith('status', ['pending', 'accepted']);
    });

    it('409s rather than resurrecting a booking that changed underneath it', async () => {
      // A cancel racing a respond could write 'cancelled' and then be
      // overwritten back to 'accepted'.
      const { db } = raceLost(pendingBooking({ status: 'accepted' }));
      const service = new BookingsService(db);

      await expect(
        service.cancel(makeUser({ id: 'artist-1' }), 'booking-1', {} as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not tell the other party about a cancellation that did not happen', async () => {
      const bookings = createMockQueryBuilder();
      bookings.first.mockResolvedValue(pendingBooking({ status: 'accepted' }));
      bookings.returning.mockResolvedValue([]);
      const notifications = createMockQueryBuilder();
      const db = createMockDb({ bookings, notifications });
      const service = new BookingsService(db);

      await service
        .cancel(makeUser({ id: 'artist-1' }), 'booking-1', {} as any)
        .catch(() => undefined);

      expect(notifications.insert).not.toHaveBeenCalled();
    });
  });
});
