import { PlannersService } from './planners.service';
import { createMockDb } from '../test-utils/knex-mock';

describe('PlannersService', () => {
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
