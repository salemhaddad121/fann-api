import {
  priceBand,
  snapPriceCeiling,
  snapPriceFloor,
  profileColumnsFor,
  resolveViewerTier,
  shapeArtistProfile,
} from './artist-visibility';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

const ACTIVE_LOOKUP = 'subscriptions as s';

function fullRow() {
  return {
    id: 'ap-1',
    user_id: 'artist-1',
    display_name: 'Karim Nassar',
    bio: 'Wedding DJ',
    location_city: 'Beirut',
    base_price_usd: '350.00',
    social_links: { instagram: '@karim' },
    deposit_usd: '100.00',
    cancellation_policy: '48 hours notice',
    avg_rating: '4.8',
    review_count: 12,
  };
}

/**
 * Everything a subscription is supposed to be buying.
 *
 * Booking terms are deliberately absent: a deposit and a cancellation
 * policy are what a booker needs to judge whether an artist is worth
 * pursuing, and neither can be used to book around the platform.
 */
const PAYWALLED_FIELDS = ['base_price_usd', 'social_links'];

function dbWithSubscription(subscription: unknown) {
  const chain = createMockQueryBuilder();
  chain.first.mockResolvedValueOnce(subscription);
  return createMockDb({ [ACTIVE_LOOKUP]: chain });
}

describe('profileColumnsFor()', () => {
  it('never selects paywalled columns below the paying tier', () => {
    // The columns are the real control. Anything not selected cannot be
    // leaked by a later refactor of the shaping code.
    const columns = profileColumnsFor('guest');

    expect(columns).not.toContain('ap.social_links');
  });

  it('selects them for a subscriber', () => {
    const columns = profileColumnsFor('subscribed');

    expect(columns).toContain('ap.social_links');
  });

  it('gives booking terms to every tier', () => {
    // A deposit and a cancellation policy are what a booker needs to
    // decide whether an artist is worth pursuing at all, and neither can
    // be used to book around the platform the way a name or a number can.
    for (const tier of ['guest', 'registered', 'subscribed'] as const) {
      expect(profileColumnsFor(tier)).toEqual(
        expect.arrayContaining(['ap.deposit_usd', 'ap.cancellation_policy']),
      );
    }
  });

  it('still reads the two columns it has to transform', () => {
    // The name has to be read to be masked, and the band cannot be computed
    // without the figure. shapeArtistProfile() is what stops either raw
    // value reaching the response.
    const columns = profileColumnsFor('guest');

    expect(columns).toEqual(expect.arrayContaining(['ap.display_name', 'ap.base_price_usd']));
  });

  it('never selects the whole table', () => {
    expect(profileColumnsFor('subscribed')).not.toContain('ap.*');
    expect(profileColumnsFor('guest')).not.toContain('ap.*');
  });
});

describe('shapeArtistProfile()', () => {
  it.each(['guest', 'registered'] as const)(
    'strips every paywalled field for a %s viewer',
    (tier) => {
      const shaped = shapeArtistProfile(fullRow(), tier);

      for (const field of PAYWALLED_FIELDS) {
        expect(shaped).not.toHaveProperty(field);
      }
    },
  );

  it('masks the display name rather than removing it', () => {
    // A guest still needs to tell two results apart; they just must not be
    // able to look the artist up and book around the platform.
    const shaped = shapeArtistProfile(fullRow(), 'guest');

    expect(shaped.display_name).toBe('Karim N.');
    expect(JSON.stringify(shaped)).not.toContain('Nassar');
  });

  it('replaces the exact price with a band', () => {
    const shaped = shapeArtistProfile(fullRow(), 'guest');

    expect(shaped.base_price_band).toBe('$250–$500');
    expect(JSON.stringify(shaped)).not.toContain('350');
  });

  it('leaves everything intact for a subscriber', () => {
    const shaped = shapeArtistProfile(fullRow(), 'subscribed');

    expect(shaped.display_name).toBe('Karim Nassar');
    expect(shaped.base_price_usd).toBe('350.00');
    expect(shaped.social_links).toEqual({ instagram: '@karim' });
    expect(shaped.is_masked).toBe(false);
  });

  it('reports the tier so the client can ask for the right thing', () => {
    // Guests and registered users get identical data but need different
    // prompts — "sign in" versus "subscribe".
    expect(shapeArtistProfile(fullRow(), 'guest').viewer_tier).toBe('guest');
    expect(shapeArtistProfile(fullRow(), 'registered').viewer_tier).toBe('registered');
  });

  it('keeps the freely visible fields', () => {
    const shaped = shapeArtistProfile(fullRow(), 'guest');

    expect(shaped.location_city).toBe('Beirut');
    expect(shaped.avg_rating).toBe('4.8');
    expect(shaped.review_count).toBe(12);
    expect(shaped.bio).toBe('Wedding DJ');
  });

  it.each(['guest', 'registered'] as const)(
    'shows booking terms to a %s viewer',
    (tier) => {
      const shaped = shapeArtistProfile(fullRow(), tier);

      expect(shaped.deposit_usd).toBe('100.00');
      expect(shaped.cancellation_policy).toBe('48 hours notice');
    },
  );
});

describe('priceBand()', () => {
  it.each([
    ['50', 'Under $100'],
    ['100', '$100–$250'],
    ['350', '$250–$500'],
    ['999', '$500–$1,000'],
    ['1500', '$1,000–$2,500'],
    ['2500', '$2,500+'],
    ['9000', '$2,500+'],
  ])('puts %s in %s', (price, expected) => {
    expect(priceBand(price)).toBe(expected);
  });

  it('returns null when no price is set', () => {
    expect(priceBand(null)).toBeNull();
    expect(priceBand(undefined)).toBeNull();
    expect(priceBand('not-a-number')).toBeNull();
  });
});

describe('resolveViewerTier()', () => {
  it('treats a caller with no session as a guest', async () => {
    await expect(resolveViewerTier(createMockDb(), {})).resolves.toBe('guest');
  });

  it('treats a signed-in user without a subscription as registered', async () => {
    // An account on its own unlocks nothing.
    const tier = await resolveViewerTier(dbWithSubscription(undefined), { userId: 'u1' });

    expect(tier).toBe('registered');
  });

  it('treats a subscriber as subscribed', async () => {
    const tier = await resolveViewerTier(dbWithSubscription({ id: 'sub-1' }), { userId: 'u1' });

    expect(tier).toBe('subscribed');
  });

  it('does not mask an artist their own profile', async () => {
    // Finding your own name starred out on your own page reads as a bug.
    const tier = await resolveViewerTier(createMockDb(), { userId: 'artist-1' }, 'artist-1');

    expect(tier).toBe('subscribed');
  });

  it('gives an admin the real record', async () => {
    // Moderation is impossible against masked data.
    const tier = await resolveViewerTier(createMockDb(), { userId: 'a1', role: 'admin' });

    expect(tier).toBe('subscribed');
  });
});

describe('price filter snapping', () => {
  it.each([
    [340, 250],
    [251, 250],
    [99, 0],
    [100, 100],
    [2600, 2500],
  ])('snaps a floor of %s down to %s', (input, expected) => {
    // A viewer who only sees "$250–$500" could otherwise send minPrice=340,
    // then 341, then 342, and read the exact figure off which query stops
    // returning the artist. Snapping means they can only filter at the
    // granularity they can already see.
    expect(snapPriceFloor(input)).toBe(expected);
  });

  it.each([
    [340, 500],
    [101, 250],
    [50, 100],
  ])('snaps a ceiling of %s up to %s', (input, expected) => {
    expect(snapPriceCeiling(input)).toBe(expected);
  });

  it('drops a ceiling above the top band rather than inventing a cap', () => {
    // "$2,500+" is open-ended; capping it would exclude artists the viewer
    // asked to see.
    expect(snapPriceCeiling(9000)).toBeUndefined();
  });

  it('leaves an absent filter absent', () => {
    expect(snapPriceFloor(undefined)).toBeUndefined();
    expect(snapPriceCeiling(undefined)).toBeUndefined();
  });

  it('never lets a snapped floor exceed the price it was derived from', () => {
    // The property that matters: snapping must only ever widen the result
    // set, never narrow it past what was asked for.
    for (const value of [0, 1, 99, 100, 249, 250, 499, 1200, 5000]) {
      expect(snapPriceFloor(value)!).toBeLessThanOrEqual(value);
    }
  });
});
