import { ArtistsService } from './artists.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

/**
 * These cover the WIRING, which is the part artist-visibility.spec.ts
 * cannot reach.
 *
 * That spec proves the shaping helpers are correct in isolation: the right
 * columns per tier, the right mask, the right band. It says nothing about
 * whether ArtistsService actually calls them. Reinstating `SELECT ap.*` in
 * search() — the exact leak Wave 3 existed to close — leaves every one of
 * those tests green, because none of them runs the service.
 *
 * So what is asserted here is deliberately about the query the service
 * builds and the object it returns, not about the helpers' internals.
 */

const ARTIST_ROW = {
  id: 'ap-1',
  user_id: 'artist-1',
  display_name: 'Karim Nassar',
  bio: 'Wedding DJ',
  location_city: 'Beirut',
  base_price_usd: '350.00',
  social_links: { instagram: '@karim' },
  deposit_usd: '100.00',
  cancellation_policy: '48 hours notice',
};

function analyticsStub() {
  return { recordSearch: jest.fn().mockResolvedValue(undefined) };
}

/**
 * Shaped rows are Record<string, unknown> by design — the whole point is
 * that which keys exist depends on the tier, so there is no static shape to
 * assert against. This just restores property access in the tests.
 */
function fields(value: unknown): Record<string, any> {
  return value as Record<string, any>;
}

/**
 * A db whose artist_profiles query returns one row and a total of 1.
 *
 * `subscriptions as s` drives resolveViewerTier: a row means the viewer is
 * subscribed, undefined means they are not.
 */
function searchDb(opts: { subscription?: unknown } = {}) {
  const profiles = createMockQueryBuilder();
  profiles.first.mockResolvedValue({ total: '1' });
  profiles.mockResolve([ARTIST_ROW]);

  const subscriptions = createMockQueryBuilder();
  subscriptions.first.mockResolvedValue(opts.subscription);

  const categories = createMockQueryBuilder();
  categories.first.mockResolvedValue({ id: 'cat-1' });

  const artistCategories = createMockQueryBuilder();
  artistCategories.mockResolve([]);

  return createMockDb({
    'artist_profiles as ap': profiles,
    'subscriptions as s': subscriptions,
    'artist_categories as ac': artistCategories,
    categories,
  });
}

/** Every column string handed to .select() across the whole query. */
function selectedColumns(db: any): string[] {
  return db('artist_profiles as ap').select.mock.calls.flat(2);
}

/** The SQL fragments handed to .whereRaw(), joined for easy matching. */
function rawClauses(db: any): string {
  return db('artist_profiles as ap')
    .whereRaw.mock.calls.map((c: any[]) => String(c[0]))
    .join(' | ');
}

describe('ArtistsService.search() — column selection', () => {
  it('never selects a paywalled column for a guest', async () => {
    // The regression this exists for: search returns the whole roster in
    // one request, so an unshaped list hands over every artist at once.
    const db = searchDb();
    await new ArtistsService(db, analyticsStub() as any).search({} as any, {});

    expect(selectedColumns(db)).not.toContain('ap.social_links');
  });

  it('selects social links once the viewer is paying', async () => {
    const db = searchDb({ subscription: { id: 'sub-1' } });
    await new ArtistsService(db, analyticsStub() as any).search({} as any, {
      userId: 'planner-1',
    });

    expect(selectedColumns(db)).toContain('ap.social_links');
  });

  it('never selects the whole table', async () => {
    // `SELECT ap.*` was the original leak. An allowlist only works while
    // nobody reaches for the star again.
    const db = searchDb();
    await new ArtistsService(db, analyticsStub() as any).search({} as any, {});

    expect(selectedColumns(db)).not.toContain('ap.*');
  });
});

describe('ArtistsService.search() — shaping the response', () => {
  it('masks the name and replaces the price with a band for a guest', async () => {
    const db = searchDb();
    const result = await new ArtistsService(db, analyticsStub() as any).search(
      {} as any,
      {},
    );

    const artist = fields(result.data[0]);
    expect(artist.display_name).toBe('Karim N.');
    expect(artist.base_price_band).toBe('$250–$500');
    expect(artist).not.toHaveProperty('base_price_usd');
    expect(artist).not.toHaveProperty('social_links');
    expect(artist.is_masked).toBe(true);
  });

  it('hands a subscriber the real name and the exact price', async () => {
    const db = searchDb({ subscription: { id: 'sub-1' } });
    const result = await new ArtistsService(db, analyticsStub() as any).search(
      {} as any,
      { userId: 'planner-1' },
    );

    const artist = fields(result.data[0]);
    expect(artist.display_name).toBe('Karim Nassar');
    expect(artist.base_price_usd).toBe('350.00');
    expect(artist.is_masked).toBe(false);
  });

  it('keeps booking terms visible to a guest', async () => {
    // Salem's call, and deliberate: a deposit and a cancellation policy
    // inform a decision and cannot be used to book around the platform.
    const db = searchDb();
    const result = await new ArtistsService(db, analyticsStub() as any).search(
      {} as any,
      {},
    );

    expect(fields(result.data[0]).deposit_usd).toBe('100.00');
    expect(fields(result.data[0]).cancellation_policy).toBe('48 hours notice');
  });

  it('reports the tier it saw, so the client knows which CTA to show', async () => {
    // Guests and registered users get identical data; only the ask differs
    // — "sign in" versus "subscribe".
    const guest = searchDb();
    const registered = searchDb({ subscription: undefined });

    const asGuest = await new ArtistsService(guest, analyticsStub() as any).search(
      {} as any,
      {},
    );
    const asRegistered = await new ArtistsService(
      registered,
      analyticsStub() as any,
    ).search({} as any, { userId: 'planner-1' });

    expect(fields(asGuest.data[0]).viewer_tier).toBe('guest');
    expect(fields(asRegistered.data[0]).viewer_tier).toBe('registered');
    expect(fields(asRegistered.data[0]).display_name).toBe(
      fields(asGuest.data[0]).display_name,
    );
  });
});

describe('ArtistsService.search() — probing defences', () => {
  it('matches a masked name on its first word only', async () => {
    // Otherwise the mask is decoration: type "Nassar", see a hit, and the
    // surname the response shortened to "N." is confirmed.
    const db = searchDb();
    await new ArtistsService(db, analyticsStub() as any).search(
      { q: 'Nassar' } as any,
      {},
    );

    expect(rawClauses(db)).toContain('split_part');
  });

  it('matches the full name for a subscriber', async () => {
    const db = searchDb({ subscription: { id: 'sub-1' } });
    await new ArtistsService(db, analyticsStub() as any).search(
      { q: 'Nassar' } as any,
      { userId: 'planner-1' },
    );

    const raw = rawClauses(db);
    expect(raw).toContain('ap.display_name ILIKE');
    expect(raw).not.toContain('split_part');
  });

  it('snaps a guest price filter to the band edge', async () => {
    // Unsnapped, minPrice=340 then 341 then 342 reads the exact figure off
    // whichever query stops returning the artist.
    const db = searchDb();
    await new ArtistsService(db, analyticsStub() as any).search(
      { minPrice: 340, maxPrice: 360 } as any,
      {},
    );

    const priceFilters = db('artist_profiles as ap')
      .where.mock.calls.filter((c: any[]) => c[0] === 'ap.base_price_usd');

    expect(priceFilters).toEqual([
      ['ap.base_price_usd', '>=', 250],
      ['ap.base_price_usd', '<=', 500],
    ]);
  });

  it('passes a subscriber price filter through untouched', async () => {
    const db = searchDb({ subscription: { id: 'sub-1' } });
    await new ArtistsService(db, analyticsStub() as any).search(
      { minPrice: 340, maxPrice: 360 } as any,
      { userId: 'planner-1' },
    );

    const priceFilters = db('artist_profiles as ap')
      .where.mock.calls.filter((c: any[]) => c[0] === 'ap.base_price_usd');

    expect(priceFilters).toEqual([
      ['ap.base_price_usd', '>=', 340],
      ['ap.base_price_usd', '<=', 360],
    ]);
  });
});

describe('ArtistsService.search() — telemetry', () => {
  it('records the count the server computed, not one the client sent', async () => {
    // These numbers answer "which categories should we recruit for?", a
    // question that is worse than useless if the data can be gamed.
    const analytics = analyticsStub();
    const db = searchDb();

    await new ArtistsService(db, analytics as any).search(
      { q: 'dj', resultCount: 9999 } as any,
      { sessionId: 'session-1' },
    );

    expect(analytics.recordSearch).toHaveBeenCalledWith(
      expect.objectContaining({ queryText: 'dj', resultCount: 1, sessionId: 'session-1' }),
    );
  });

  it('only lists active artists', async () => {
    const db = searchDb();
    await new ArtistsService(db, analyticsStub() as any).search({} as any, {});

    expect(db('artist_profiles as ap').where).toHaveBeenCalledWith('u.status', 'active');
  });
});

describe('ArtistsService.findOne()', () => {
  function profileDb(opts: { owner?: unknown; subscription?: unknown } = {}) {
    const profiles = createMockQueryBuilder();
    profiles.first
      .mockResolvedValueOnce(
        'owner' in opts ? opts.owner : { user_id: 'artist-1' },
      )
      .mockResolvedValueOnce({ ...ARTIST_ROW, joined_at: new Date('2026-01-01') });

    const subscriptions = createMockQueryBuilder();
    subscriptions.first.mockResolvedValue(opts.subscription);

    const bookings = createMockQueryBuilder();
    bookings.first.mockResolvedValue({ count: '4' });

    const db = createMockDb({
      'artist_profiles as ap': profiles,
      'subscriptions as s': subscriptions,
      bookings,
    });
    return db;
  }

  it('does not mask an artist their own name', async () => {
    // An artist opening their own public page finding "Karim N." staring
    // back is not a paywall question.
    const db = profileDb();
    const result = await new ArtistsService(db, analyticsStub() as any).findOne(
      'ap-1',
      { userId: 'artist-1' },
    );

    expect(fields(result).display_name).toBe('Karim Nassar');
    expect(fields(result).viewer_tier).toBe('subscribed');
  });

  it('masks for an unrelated guest', async () => {
    const db = profileDb();
    const result = await new ArtistsService(db, analyticsStub() as any).findOne(
      'ap-1',
      {},
    );

    expect(fields(result).display_name).toBe('Karim N.');
    expect(result).not.toHaveProperty('base_price_usd');
  });

  it('gives an admin the unmasked profile', async () => {
    // Moderating a profile against a report needs the real thing.
    const db = profileDb();
    const result = await new ArtistsService(db, analyticsStub() as any).findOne(
      'ap-1',
      { userId: 'admin-1', role: 'admin' },
    );

    expect(fields(result).display_name).toBe('Karim Nassar');
  });

  it('404s for an artist who is not active, without leaking that they exist', async () => {
    const db = profileDb({ owner: undefined });

    await expect(
      new ArtistsService(db, analyticsStub() as any).findOne('ap-1', {}),
    ).rejects.toThrow('Artist not found.');
  });
});
