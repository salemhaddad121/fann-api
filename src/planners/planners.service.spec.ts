import knex from 'knex';
import { PlannersService } from './planners.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

describe('PlannersService', () => {
  /**
   * Compiles the event-type filter with a real Knex, no connection.
   *
   * The mock builder treats whereRaw as a chainable no-op, so it never
   * compiles SQL — which is how `pp.event_types ??| ?::text[]` shipped and
   * made every filtered request fail with "Expected 1 bindings, saw 2".
   * Knex reads "??" as an identifier placeholder, so it counted two
   * placeholders against one binding. Only toSQL() catches that, so this
   * test builds the fragment the way the service does and compiles it.
   */
  describe('event-type filter SQL', () => {
    const pg = knex({ client: 'pg' });

    afterAll(async () => {
      await pg.destroy();
    });

    function compile(eventTypes: string[]) {
      return pg('planner_profiles as pp')
        .whereRaw(`jsonb_exists_any(pp.event_types, ?::text[])`, [eventTypes])
        .toSQL();
    }

    it('compiles with exactly one binding, whatever the list length', () => {
      expect(() => compile(['Wedding'])).not.toThrow();
      expect(() => compile(['Wedding', 'Corporate', 'Private Party'])).not.toThrow();

      const { bindings } = compile(['Wedding', 'Corporate']);
      expect(bindings).toEqual([['Wedding', 'Corporate']]);
    });

    it('passes the list as a single array parameter rather than expanding it', () => {
      // Expansion into one binding per value is the other way this breaks:
      // the cast to text[] would then receive a bare string.
      const { sql, bindings } = compile(['Wedding', 'Corporate']);
      expect(sql).toContain('jsonb_exists_any');
      expect(sql).not.toContain('??');
      expect(bindings).toHaveLength(1);
    });
  });

  describe('getEventTypes()', () => {
    it('maps the raw query rows to a plain string array', async () => {
      const db = createMockDb();
      db.raw.mockResolvedValueOnce({
        rows: [
          { event_type: 'Corporate' },
          { event_type: 'Wedding' },
        ],
      });
      const service = new PlannersService(db);

      const result = await service.getEventTypes();

      expect(result).toEqual(['Corporate', 'Wedding']);
    });

    it('returns an empty array when no active planner has any event types yet', async () => {
      const db = createMockDb();
      db.raw.mockResolvedValueOnce({ rows: [] });
      const service = new PlannersService(db);

      const result = await service.getEventTypes();

      expect(result).toEqual([]);
    });
  });
});

// ----------------------------------------------------------------
// C5 — the planner directory was @Public() on both routes, so anyone with
// a browser and no account could page through every booker on Fann:
// display name, company name, bio, city, social links. Survivable while
// every booker was a business; the $5 day pass fills that list with
// private individuals.
//
// The guards are on the controller. What the service owes is the hard
// company-only floor, on BOTH entry points — a list filter that findOne()
// does not repeat is the same leak through a different door.
// ----------------------------------------------------------------
describe('PlannersService — company-only floor', () => {
  function conditionsOn(builder: any) {
    return JSON.stringify([
      builder.where.mock.calls,
      builder.whereIn.mock.calls,
      builder.whereRaw.mock.calls,
    ]);
  }

  it('search() filters to companies unconditionally', async () => {
    const profiles = createMockQueryBuilder();
    profiles.first.mockResolvedValue({ total: '0' });
    profiles.mockResolve([]);
    const db = createMockDb({ 'planner_profiles as pp': profiles });

    await new PlannersService(db).search({} as never);

    expect(profiles.whereIn).toHaveBeenCalledWith('pp.planner_kind', ['company']);
  });

  it('applies the floor even when the caller passes filters', async () => {
    // It must not be reachable as a user-supplied parameter — no query
    // string should be able to widen it.
    const profiles = createMockQueryBuilder();
    profiles.first.mockResolvedValue({ total: '0' });
    profiles.mockResolve([]);
    const db = createMockDb({ 'planner_profiles as pp': profiles });

    await new PlannersService(db).search({
      q: 'anything',
      city: 'Beirut',
      page: 3,
    } as never);

    expect(conditionsOn(profiles)).toContain('planner_kind');
  });

  it('findOne() applies the same floor', async () => {
    // Without this an artist who kept or guessed a planner UUID reads an
    // individual's profile directly.
    const profiles = createMockQueryBuilder();
    profiles.first.mockResolvedValue(undefined);
    const db = createMockDb({ 'planner_profiles as pp': profiles });

    await expect(
      new PlannersService(db).findOne('00000000-0000-4000-8000-000000000001'),
    ).rejects.toThrow('Planner not found.');

    expect(profiles.whereIn).toHaveBeenCalledWith('pp.planner_kind', ['company']);
  });

  it('404s rather than 403s for an individual', async () => {
    // A 403 would confirm the id names a real person, which is the fact
    // being protected. Matches how the codebase already hides rows a
    // caller is not entitled to see.
    const profiles = createMockQueryBuilder();
    profiles.first.mockResolvedValue(undefined);
    const db = createMockDb({ 'planner_profiles as pp': profiles });

    await expect(
      new PlannersService(db).findOne('00000000-0000-4000-8000-000000000001'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
