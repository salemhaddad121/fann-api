import { AnalyticsService } from './analytics.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

const SESSION = '11111111-2222-3333-4444-555555555555';

function batch(events: { path: string; durationMs: number }[]) {
  return {
    sessionId: SESSION,
    events: events.map((e) => ({ ...e, occurredAt: '2026-08-15T10:00:00.000Z' })),
  } as any;
}

describe('AnalyticsService.recordPageEvents()', () => {
  it('records a guest with no user, no role, and is_guest set', async () => {
    const pageEvents = createMockQueryBuilder();
    const service = new AnalyticsService(createMockDb({ page_events: pageEvents }));

    await service.recordPageEvents({}, batch([{ path: '/search', durationMs: 4000 }]));

    const [rows] = pageEvents.insert.mock.calls[0];
    expect(rows[0]).toMatchObject({
      user_id: null,
      role: null,
      is_guest: true,
      session_id: SESSION,
      path: '/search',
    });
  });

  it('takes identity from the session, never from the payload', async () => {
    // Otherwise a client could attribute its activity to the other side of
    // the marketplace and skew every role-split metric.
    const pageEvents = createMockQueryBuilder();
    const service = new AnalyticsService(createMockDb({ page_events: pageEvents }));

    const payload = batch([{ path: '/search', durationMs: 1000 }]);
    payload.events[0].role = 'admin';
    payload.userId = 'someone-else';

    await service.recordPageEvents({ userId: 'user-1', role: 'planner' }, payload);

    const [rows] = pageEvents.insert.mock.calls[0];
    expect(rows[0]).toMatchObject({ user_id: 'user-1', role: 'planner', is_guest: false });
  });

  it('drops zero-length views', async () => {
    // A route passed through on the way somewhere else was not read.
    const pageEvents = createMockQueryBuilder();
    const service = new AnalyticsService(createMockDb({ page_events: pageEvents }));

    const result = await service.recordPageEvents(
      {},
      batch([
        { path: '/search', durationMs: 0 },
        { path: '/artists/[id]', durationMs: 2500 },
      ]),
    );

    expect(result.recorded).toBe(1);
    const [rows] = pageEvents.insert.mock.calls[0];
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('/artists/[id]');
  });

  it('writes nothing when every event is zero-length', async () => {
    const pageEvents = createMockQueryBuilder();
    const service = new AnalyticsService(createMockDb({ page_events: pageEvents }));

    await service.recordPageEvents({}, batch([{ path: '/search', durationMs: 0 }]));

    expect(pageEvents.insert).not.toHaveBeenCalled();
  });
});

describe('AnalyticsService.recordSearch()', () => {
  it('marks a search with no user as a guest search', async () => {
    const searchEvents = createMockQueryBuilder();
    const service = new AnalyticsService(createMockDb({ search_events: searchEvents }));

    await service.recordSearch({ sessionId: SESSION, queryText: 'dj', resultCount: 6 });

    expect(searchEvents.insert).toHaveBeenCalledWith(
      expect.objectContaining({ is_guest: true, user_id: null, query_text: 'dj', result_count: 6 }),
    );
  });

  it('truncates an overlong query rather than rejecting it', async () => {
    const searchEvents = createMockQueryBuilder();
    const service = new AnalyticsService(createMockDb({ search_events: searchEvents }));

    await service.recordSearch({ queryText: 'x'.repeat(500) });

    const [row] = searchEvents.insert.mock.calls[0];
    expect(row.query_text).toHaveLength(200);
  });

  it('never lets a telemetry failure break the search that triggered it', async () => {
    // This is called from inside the search handler. A failed insert must
    // cost the row, not turn a working search into a 500.
    const searchEvents = createMockQueryBuilder();
    searchEvents.insert.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    const service = new AnalyticsService(createMockDb({ search_events: searchEvents }));

    await expect(service.recordSearch({ queryText: 'dj' })).resolves.toBeUndefined();
  });
});

describe('AnalyticsService.pruneOldEvents()', () => {
  it('prunes searches as well as page views', async () => {
    // search_events holds free text people typed, much of it now from
    // guests who agreed to nothing. Retention is the only control on it.
    const pageEvents = createMockQueryBuilder();
    const searchEvents = createMockQueryBuilder();
    pageEvents.del.mockResolvedValueOnce(4);
    searchEvents.del.mockResolvedValueOnce(3);

    const service = new AnalyticsService(
      createMockDb({ page_events: pageEvents, search_events: searchEvents }),
    );

    await expect(service.pruneOldEvents()).resolves.toBe(7);
    expect(pageEvents.del).toHaveBeenCalled();
    expect(searchEvents.del).toHaveBeenCalled();
  });
});
