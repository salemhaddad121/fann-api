import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReviewsService, REVIEW_WINDOW_DAYS } from './reviews.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';
import { UserRecord } from '../users/users.types';

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'planner-1',
    email: 'planner@example.com',
    phone: null,
    passwordHash: 'hash',
    role: 'planner',
    status: 'active',
    accountCode: 'PLN-001',
    emailVerifiedAt: null,
    phoneVerifiedAt: null,
    createdAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

const baseDto = {
  bookingId: 'booking-1',
  overallScore: 5,
  scoreCommunication: 5,
  scorePunctuality: 5,
  scoreProfessionalism: 5,
  scoreQuality: 5,
} as any;

describe('ReviewsService.submit()', () => {
  it('rejects a booking that does not exist', async () => {
    const bookings = createMockQueryBuilder();
    bookings.first.mockResolvedValueOnce(undefined);
    const db = createMockDb({ bookings });
    const service = new ReviewsService(db);

    await expect(service.submit(makeUser(), baseDto)).rejects.toThrow(NotFoundException);
  });

  it('rejects a booking that is not completed', async () => {
    const bookings = createMockQueryBuilder();
    bookings.first.mockResolvedValueOnce({
      id: 'booking-1',
      status: 'accepted', // not completed yet
      artist_id: 'artist-1',
      planner_id: 'planner-1',
    });
    const db = createMockDb({ bookings });
    const service = new ReviewsService(db);

    await expect(service.submit(makeUser(), baseDto)).rejects.toThrow(BadRequestException);
  });

  it('rejects someone who is not a participant in the booking', async () => {
    const bookings = createMockQueryBuilder();
    bookings.first.mockResolvedValueOnce({
      id: 'booking-1',
      status: 'completed',
      artist_id: 'artist-1',
      planner_id: 'someone-else',
    });
    const db = createMockDb({ bookings });
    const service = new ReviewsService(db);

    await expect(
      service.submit(makeUser({ id: 'planner-1' }), baseDto),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a submission after the 7-day review window has closed', async () => {
    const bookings = createMockQueryBuilder();
    const emailsSentAt = new Date();
    emailsSentAt.setDate(emailsSentAt.getDate() - (REVIEW_WINDOW_DAYS + 1)); // 8 days ago
    bookings.first.mockResolvedValueOnce({
      id: 'booking-1',
      status: 'completed',
      artist_id: 'artist-1',
      planner_id: 'planner-1',
      review_emails_sent_at: emailsSentAt,
    });
    const db = createMockDb({ bookings });
    const service = new ReviewsService(db);

    await expect(
      service.submit(makeUser({ id: 'planner-1' }), baseDto),
    ).rejects.toThrow(BadRequestException);
  });

  it('allows a submission still within the 7-day window', async () => {
    const bookings = createMockQueryBuilder();
    const emailsSentAt = new Date();
    emailsSentAt.setDate(emailsSentAt.getDate() - (REVIEW_WINDOW_DAYS - 1)); // 6 days ago — still open
    bookings.first.mockResolvedValueOnce({
      id: 'booking-1',
      status: 'completed',
      artist_id: 'artist-1',
      planner_id: 'planner-1',
      review_emails_sent_at: emailsSentAt,
    });

    const reviews = createMockQueryBuilder();
    reviews.first.mockResolvedValueOnce(undefined); // no existing review yet
    reviews.returning.mockResolvedValueOnce([{ id: 'review-1', is_visible: false }]);
    reviews.mockResolve([{ id: 'review-1', reviewee_id: 'artist-1' }]); // tryUnlockPair sees only 1 review so far

    const db = createMockDb({ bookings, reviews });
    const service = new ReviewsService(db);

    const result = await service.submit(makeUser({ id: 'planner-1' }), baseDto);
    expect(result.is_visible).toBe(false);
    expect(result.message).toMatch(/submitted/i);
  });

  it('rejects a second review from the same person for the same booking', async () => {
    const bookings = createMockQueryBuilder();
    bookings.first.mockResolvedValueOnce({
      id: 'booking-1',
      status: 'completed',
      artist_id: 'artist-1',
      planner_id: 'planner-1',
    });
    const reviews = createMockQueryBuilder();
    reviews.first.mockResolvedValueOnce({ id: 'existing-review' }); // already reviewed
    const db = createMockDb({ bookings, reviews });
    const service = new ReviewsService(db);

    await expect(
      service.submit(makeUser({ id: 'planner-1' }), baseDto),
    ).rejects.toThrow(BadRequestException);
  });

  it('unlocks both reviews once the second party also submits', async () => {
    const bookings = createMockQueryBuilder();
    bookings.first.mockResolvedValueOnce({
      id: 'booking-1',
      status: 'completed',
      artist_id: 'artist-1',
      planner_id: 'planner-1',
    });

    const reviews = createMockQueryBuilder();
    // Call order within submit() -> tryUnlockPair() -> recalculateAggregate() x2:
    reviews.first
      .mockResolvedValueOnce(undefined) // 1. no existing review from this reviewer
      .mockResolvedValueOnce({ avg: '4.5', count: '1' }) // 2. recalculateAggregate for review #1's reviewee
      .mockResolvedValueOnce({ avg: '5.0', count: '1' }); // 3. recalculateAggregate for review #2's reviewee
    reviews.returning.mockResolvedValueOnce([{ id: 'review-2', is_visible: false }]);
    // tryUnlockPair's plain select (no .first()) now finds BOTH reviews present.
    reviews.mockResolve([
      { id: 'review-1', reviewee_id: 'planner-1', is_visible: false },
      { id: 'review-2', reviewee_id: 'artist-1', is_visible: false },
    ]);

    const db = createMockDb({ bookings, reviews });
    const service = new ReviewsService(db);

    await service.submit(makeUser({ id: 'planner-1' }), baseDto);

    // Both reviews get marked visible once the pair is complete.
    expect(reviews.update).toHaveBeenCalledWith({ is_visible: true });
  });
});
