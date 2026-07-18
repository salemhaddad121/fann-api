import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
