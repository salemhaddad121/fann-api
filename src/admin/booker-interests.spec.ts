import { AdminService } from './admin.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

const verificationStub = { recordAdminDecision: jest.fn() };
const subscriptionsStub = { mintForPayment: jest.fn() };
const identityStub = { hasCompleteVerification: jest.fn() };

/**
 * What bookers said they came for at signup.
 *
 * The buckets do not filter anybody's search — a booker uses the filters
 * on /search like everyone else. They exist so there is an honest answer
 * to "what are people actually coming here to book", which means the
 * arithmetic has to be right or the answer is worse than none.
 */
function setup(
  rows: { interest: string; planner_kind: string | null; count: number }[],
  answering: number,
  totalBookers: number,
) {
  const interests = createMockQueryBuilder();
  interests.mockResolve(rows);
  interests.first.mockResolvedValue({ count: String(answering) });

  const profiles = createMockQueryBuilder();
  profiles.first.mockResolvedValue({ count: String(totalBookers) });

  const db = createMockDb({
    'planner_interests as pi': interests,
    planner_interests: interests,
    planner_profiles: profiles,
  });

  return new AdminService(
    db,
    verificationStub as any,
    subscriptionsStub as any,
    identityStub as any,
  );
}

describe('AdminService.getBookerInterests()', () => {
  it('splits each bucket by individual and company', async () => {
    const service = setup(
      [
        { interest: 'photo_video', planner_kind: 'individual', count: 6 },
        { interest: 'photo_video', planner_kind: 'company', count: 4 },
      ],
      10,
      10,
    );

    const { interests } = await service.getBookerInterests();

    expect(interests[0]).toMatchObject({
      interest: 'photo_video',
      total: 10,
      individual: 6,
      company: 4,
    });
  });

  it('measures share against BOOKERS, not against the sum of picks', async () => {
    // The question is multi-select: a wedding wants a band AND a
    // photographer AND a DJ. Ten bookers can produce twenty picks, and a
    // percentage computed against twenty would be meaningless.
    const service = setup(
      [
        { interest: 'musical_acts', planner_kind: 'individual', count: 10 },
        { interest: 'photo_video', planner_kind: 'individual', count: 10 },
      ],
      10,
      10,
    );

    const { interests, answering } = await service.getBookerInterests();

    expect(answering).toBe(10);
    // Both at 100% — every booker picked both. Against the sum of picks
    // each would have read 50%, which would be wrong.
    expect(interests[0].share).toBe(1);
    expect(interests[1].share).toBe(1);
  });

  it('sorts most-wanted first', async () => {
    const service = setup(
      [
        { interest: 'venues', planner_kind: 'individual', count: 2 },
        { interest: 'musical_acts', planner_kind: 'individual', count: 9 },
        { interest: 'photo_video', planner_kind: 'company', count: 5 },
      ],
      10,
      10,
    );

    const { interests } = await service.getBookerInterests();

    expect(interests.map((i) => i.interest)).toEqual([
      'musical_acts',
      'photo_video',
      'venues',
    ]);
  });

  it('reports bookers who predate the question separately', async () => {
    // Counting them as "wanted nothing" would drag every share down for a
    // reason that has nothing to do with demand.
    const service = setup(
      [{ interest: 'musical_acts', planner_kind: 'individual', count: 4 }],
      4,
      30,
    );

    const result = await service.getBookerInterests();

    expect(result).toMatchObject({ answering: 4, totalBookers: 30, unanswered: 26 });
    expect(result.interests[0].share).toBe(1); // 4 of the 4 who answered
  });

  it('counts a null kind toward the total but neither split', async () => {
    // A booker who answered the interest question before the kind question
    // existed. Bucketing them as individuals would invent data.
    const service = setup(
      [{ interest: 'musical_acts', planner_kind: null, count: 3 }],
      3,
      3,
    );

    const { interests } = await service.getBookerInterests();

    expect(interests[0]).toMatchObject({ total: 3, individual: 0, company: 0 });
  });

  it('survives an empty platform without dividing by zero', async () => {
    const service = setup([], 0, 0);

    const result = await service.getBookerInterests();

    expect(result).toEqual({
      interests: [],
      answering: 0,
      totalBookers: 0,
      unanswered: 0,
    });
  });

  it('never reports a negative unanswered count', async () => {
    // Defensive: the two counts are separate queries, so a signup landing
    // between them could in principle make answering exceed the total.
    const service = setup(
      [{ interest: 'venues', planner_kind: 'company', count: 5 }],
      5,
      4,
    );

    const { unanswered } = await service.getBookerInterests();

    expect(unanswered).toBe(0);
  });
});
