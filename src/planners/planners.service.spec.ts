import knex from 'knex';
import { PlannersService } from './planners.service';
import { createMockDb } from '../test-utils/knex-mock';

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
