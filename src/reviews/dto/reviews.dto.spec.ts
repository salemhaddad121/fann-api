import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SubmitReviewDto } from './reviews.dto';

const VALID_BASE = {
  bookingId: '550e8400-e29b-41d4-a716-446655440000',
  overallScore: 5,
  scoreCommunication: 5,
  scoreProfessionalism: 5,
  scorePunctuality: 5,
  scoreQuality: 5,
};

describe('SubmitReviewDto', () => {
  it('accepts a fully valid review', async () => {
    const dto = plainToInstance(SubmitReviewDto, VALID_BASE);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it.each([0, 6, -1, 100])('rejects an overall score of %d (out of 1-5 range)', async (score) => {
    const dto = plainToInstance(SubmitReviewDto, { ...VALID_BASE, overallScore: score });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'overallScore')).toBe(true);
  });

  it('rejects a non-integer score', async () => {
    const dto = plainToInstance(SubmitReviewDto, { ...VALID_BASE, scoreQuality: 3.5 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'scoreQuality')).toBe(true);
  });

  it('rejects a non-UUID bookingId', async () => {
    const dto = plainToInstance(SubmitReviewDto, { ...VALID_BASE, bookingId: 'not-a-uuid' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'bookingId')).toBe(true);
  });

  it('rejects a body longer than 2000 characters', async () => {
    const dto = plainToInstance(SubmitReviewDto, { ...VALID_BASE, body: 'x'.repeat(2001) });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'body')).toBe(true);
  });

  it('allows an absent body (optional)', async () => {
    const dto = plainToInstance(SubmitReviewDto, VALID_BASE);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
