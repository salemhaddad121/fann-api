import { UserRecord } from '../users/users.types';
import { MessagingService } from './messaging.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

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
    pendingEmail: null,
    ...overrides,
  };
}

function setUpConversation() {
  const conversations = createMockQueryBuilder();
  conversations.first.mockResolvedValueOnce({
    id: 'conv-1',
    artist_id: 'artist-1',
    planner_id: 'planner-1',
    status: 'accepted',
    initiated_by: 'planner-1',
  });

  const messages = createMockQueryBuilder();
  messages.returning.mockResolvedValueOnce([
    { id: 'msg-1', conversation_id: 'conv-1', sender_id: 'planner-1', body: 'Hi!', created_at: new Date() },
  ]);

  const plannerProfiles = createMockQueryBuilder();
  plannerProfiles.first.mockResolvedValueOnce({ display_name: 'Rania' });

  return { conversations, messages, plannerProfiles };
}

describe('MessagingService.sendMessage() — new-message notification', () => {
  it('creates a notification for the recipient when none is unread yet', async () => {
    const { conversations, messages, plannerProfiles } = setUpConversation();
    const notifications = createMockQueryBuilder();
    notifications.first.mockResolvedValueOnce(undefined); // no existing unread notification

    const db = createMockDb({
      conversations,
      messages,
      planner_profiles: plannerProfiles,
      notifications,
    });
    const service = new MessagingService(db);

    await service.sendMessage(makeUser({ id: 'planner-1', role: 'planner' }), 'conv-1', {
      body: 'Hi!',
    } as any);

    expect(notifications.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'artist-1', type: 'new_message' }),
    );
  });

  it('does not create a second notification while one is already unread', async () => {
    const { conversations, messages, plannerProfiles } = setUpConversation();
    const notifications = createMockQueryBuilder();
    notifications.first.mockResolvedValueOnce({ id: 'existing-notif' }); // already unread

    const db = createMockDb({
      conversations,
      messages,
      planner_profiles: plannerProfiles,
      notifications,
    });
    const service = new MessagingService(db);

    await service.sendMessage(makeUser({ id: 'planner-1', role: 'planner' }), 'conv-1', {
      body: 'Second message before they check!',
    } as any);

    expect(notifications.insert).not.toHaveBeenCalled();
  });

  it('notifies the artist when the planner sends, and the planner when the artist sends', async () => {
    const { conversations, messages, plannerProfiles } = setUpConversation();
    const notifications = createMockQueryBuilder();
    notifications.first.mockResolvedValueOnce(undefined);

    const db = createMockDb({
      conversations,
      messages,
      planner_profiles: plannerProfiles,
      notifications,
    });
    const service = new MessagingService(db);

    await service.sendMessage(makeUser({ id: 'planner-1', role: 'planner' }), 'conv-1', {
      body: 'Hi!',
    } as any);

    // recipient is whoever ISN'T the sender — here, the artist.
    const [insertedArg] = notifications.insert.mock.calls[0];
    expect(insertedArg.user_id).toBe('artist-1');
    expect(insertedArg.user_id).not.toBe('planner-1');
  });
});

// ----------------------------------------------------------------
// Artist-initiated conversations
// ----------------------------------------------------------------

function makeArtist() {
  return makeUser({ id: 'artist-1', role: 'artist', accountCode: 'ART-001' });
}

describe('MessagingService.createConversation() — who may initiate', () => {
  it('opens a planner-initiated thread as accepted', async () => {
    const users = createMockQueryBuilder();
    users.first.mockResolvedValueOnce({ id: 'artist-1', role: 'artist', status: 'active' });

    const conversations = createMockQueryBuilder();
    conversations.first.mockResolvedValueOnce(undefined); // no existing conversation
    conversations.returning.mockResolvedValueOnce([{ id: 'conv-1', status: 'accepted' }]);

    const db = createMockDb({ users, conversations });
    const service = new MessagingService(db);

    await service.createConversation(makeUser(), { artistId: 'artist-1' } as any);

    expect(conversations.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'accepted', initiated_by: 'planner-1' }),
    );
  });

  it('opens an artist-initiated thread as pending and notifies the planner', async () => {
    const users = createMockQueryBuilder();
    users.first.mockResolvedValueOnce({ id: 'planner-1', role: 'planner', status: 'active' });

    const conversations = createMockQueryBuilder();
    conversations.first.mockResolvedValueOnce(undefined); // no existing conversation
    conversations.returning.mockResolvedValueOnce([{ id: 'conv-1', status: 'pending' }]);

    const artistProfiles = createMockQueryBuilder();
    artistProfiles.first.mockResolvedValueOnce({ display_name: 'DJ Karim' });

    const notifications = createMockQueryBuilder();

    const db = createMockDb({
      users,
      conversations,
      artist_profiles: artistProfiles,
      notifications,
    });
    const service = new MessagingService(db);

    await service.createConversation(makeArtist(), { plannerId: 'planner-1' } as any);

    expect(conversations.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', initiated_by: 'artist-1' }),
    );
    expect(notifications.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'planner-1', type: 'message_request' }),
    );
  });

  it('refuses to re-request after a planner declined', async () => {
    const users = createMockQueryBuilder();
    users.first.mockResolvedValueOnce({ id: 'planner-1', role: 'planner', status: 'active' });

    const conversations = createMockQueryBuilder();
    conversations.first.mockResolvedValueOnce({
      id: 'conv-1',
      artist_id: 'artist-1',
      planner_id: 'planner-1',
      status: 'declined',
    });

    const db = createMockDb({ users, conversations });
    const service = new MessagingService(db);

    await expect(
      service.createConversation(makeArtist(), { plannerId: 'planner-1' } as any),
    ).rejects.toThrow(/declined/i);
    expect(conversations.insert).not.toHaveBeenCalled();
  });

  it('rejects an admin outright', async () => {
    const db = createMockDb({});
    const service = new MessagingService(db);

    await expect(
      service.createConversation(makeUser({ role: 'admin' }), { artistId: 'artist-1' } as any),
    ).rejects.toThrow(/only artists and planners/i);
  });

  it('rejects a planner who sent no artistId', async () => {
    const db = createMockDb({});
    const service = new MessagingService(db);

    await expect(service.createConversation(makeUser(), {} as any)).rejects.toThrow(
      /artistId is required/i,
    );
  });
});

describe('MessagingService.respondToRequest()', () => {
  function pendingConversation() {
    const conversations = createMockQueryBuilder();
    conversations.first.mockResolvedValueOnce({
      id: 'conv-1',
      artist_id: 'artist-1',
      planner_id: 'planner-1',
      status: 'pending',
      initiated_by: 'artist-1',
    });
    return conversations;
  }

  it('accepting flips the thread to accepted and notifies the artist', async () => {
    const conversations = pendingConversation();
    conversations.returning.mockResolvedValueOnce([{ id: 'conv-1', status: 'accepted' }]);

    const plannerProfiles = createMockQueryBuilder();
    plannerProfiles.first.mockResolvedValueOnce({ display_name: 'Rania' });
    const notifications = createMockQueryBuilder();

    const db = createMockDb({
      conversations,
      planner_profiles: plannerProfiles,
      notifications,
    });
    const service = new MessagingService(db);

    await service.respondToRequest(makeUser(), 'conv-1', 'accepted');

    expect(conversations.update).toHaveBeenCalledWith({ status: 'accepted' });
    expect(notifications.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'artist-1', type: 'message_request_accepted' }),
    );
  });

  it('declining flips the thread to declined without notifying', async () => {
    const conversations = pendingConversation();
    conversations.returning.mockResolvedValueOnce([{ id: 'conv-1', status: 'declined' }]);
    const notifications = createMockQueryBuilder();

    const db = createMockDb({ conversations, notifications });
    const service = new MessagingService(db);

    await service.respondToRequest(makeUser(), 'conv-1', 'declined');

    expect(conversations.update).toHaveBeenCalledWith({ status: 'declined' });
    expect(notifications.insert).not.toHaveBeenCalled();
  });

  it('refuses when the responder is the artist, not the planner', async () => {
    const conversations = pendingConversation();
    const db = createMockDb({ conversations });
    const service = new MessagingService(db);

    await expect(
      service.respondToRequest(makeArtist(), 'conv-1', 'accepted'),
    ).rejects.toThrow(/only the planner/i);
  });

  it('refuses to respond twice', async () => {
    const conversations = createMockQueryBuilder();
    conversations.first.mockResolvedValueOnce({
      id: 'conv-1',
      artist_id: 'artist-1',
      planner_id: 'planner-1',
      status: 'accepted',
    });
    const db = createMockDb({ conversations });
    const service = new MessagingService(db);

    await expect(
      service.respondToRequest(makeUser(), 'conv-1', 'accepted'),
    ).rejects.toThrow(/already accepted/i);
  });
});

describe('MessagingService.sendMessage() — pending request gating', () => {
  function conversationWithStatus(status: string, initiatedBy = 'artist-1') {
    const conversations = createMockQueryBuilder();
    conversations.first.mockResolvedValueOnce({
      id: 'conv-1',
      artist_id: 'artist-1',
      planner_id: 'planner-1',
      status,
      initiated_by: initiatedBy,
    });
    return conversations;
  }

  it('lets the initiating artist write while the request is pending', async () => {
    const conversations = conversationWithStatus('pending');
    const messages = createMockQueryBuilder();
    messages.returning.mockResolvedValueOnce([
      { id: 'msg-1', conversation_id: 'conv-1', sender_id: 'artist-1', body: 'Hi', created_at: new Date() },
    ]);
    const artistProfiles = createMockQueryBuilder();
    artistProfiles.first.mockResolvedValueOnce({ display_name: 'DJ Karim' });
    const notifications = createMockQueryBuilder();
    notifications.first.mockResolvedValueOnce(undefined);

    const db = createMockDb({
      conversations,
      messages,
      artist_profiles: artistProfiles,
      notifications,
    });
    const service = new MessagingService(db);

    await expect(
      service.sendMessage(makeArtist(), 'conv-1', { body: 'Hi' } as any),
    ).resolves.toBeDefined();
  });

  it('blocks the planner from replying before accepting', async () => {
    const db = createMockDb({ conversations: conversationWithStatus('pending') });
    const service = new MessagingService(db);

    await expect(
      service.sendMessage(makeUser(), 'conv-1', { body: 'Sure' } as any),
    ).rejects.toThrow(/accept this message request/i);
  });

  it('blocks everyone once the request is declined', async () => {
    const db = createMockDb({ conversations: conversationWithStatus('declined') });
    const service = new MessagingService(db);

    await expect(
      service.sendMessage(makeArtist(), 'conv-1', { body: 'Please?' } as any),
    ).rejects.toThrow(/declined/i);
  });
});

describe('MessagingService.sendMessage() — the day-pass message cap', () => {
  const SUBS_TABLE = 'subscriptions as s';

  // A capped day pass, plus however many messages have already been sent
  // in its period.
  function setUpCappedPass(alreadySent: number) {
    const { conversations, messages, plannerProfiles } = setUpConversation();

    const subs = createMockQueryBuilder();
    subs.first.mockResolvedValueOnce({
      id: 'sub-1',
      user_id: 'planner-1',
      plan_code: 'day',
      status: 'active',
      activated_at: new Date(),
      starts_at: new Date(),
      expires_at: new Date(Date.now() + 86_400_000),
      requires_id_doc: false,
      message_cap: 15,
    });

    // remainingMessages counts on the same builder the insert uses; the
    // count is read with .first(), the insert writes with .returning().
    messages.first.mockResolvedValueOnce({ sent: alreadySent });

    const db = createMockDb({
      conversations,
      messages,
      planner_profiles: plannerProfiles,
      notifications: createMockQueryBuilder(),
      [SUBS_TABLE]: subs,
    });

    return { service: new MessagingService(db), messages };
  }

  it('refuses with 402 once the pass is spent', async () => {
    // 402 rather than 403: the fix is to buy something, which is what the
    // frontend's upgrade prompt is for.
    const { service } = setUpCappedPass(15);

    await expect(
      service.sendMessage(makeUser(), 'conv-1', { body: 'One more' } as any),
    ).rejects.toMatchObject({ status: 402 });
  });

  it('says the pass is used up, not that it expired', async () => {
    // A spent day pass is still live. Telling the buyer it ended would send
    // them to re-buy the wrong thing.
    const { service } = setUpCappedPass(15);

    await expect(
      service.sendMessage(makeUser(), 'conv-1', { body: 'One more' } as any),
    ).rejects.toThrow(/used all 15 messages/i);
  });

  it('writes nothing when the cap is hit', async () => {
    const { service, messages } = setUpCappedPass(15);

    await expect(
      service.sendMessage(makeUser(), 'conv-1', { body: 'One more' } as any),
    ).rejects.toThrow();
    expect(messages.insert).not.toHaveBeenCalled();
  });

  it('allows the final message that reaches the cap', async () => {
    // 14 sent means one left. Off-by-one here either robs the buyer of a
    // message or hands out a free one.
    const { service, messages } = setUpCappedPass(14);

    await service.sendMessage(makeUser(), 'conv-1', { body: 'Number fifteen' } as any);

    expect(messages.insert).toHaveBeenCalled();
  });

  it('never counts an artist, who holds no subscription', async () => {
    // The subscriptions builder is left unstubbed, so the lookup resolves
    // undefined — exactly what an artist's does in production.
    const { conversations, messages, plannerProfiles } = setUpConversation();
    const db = createMockDb({
      conversations,
      messages,
      planner_profiles: plannerProfiles,
      notifications: createMockQueryBuilder(),
    });
    const service = new MessagingService(db);

    await service.sendMessage(
      makeUser({ id: 'artist-1', role: 'artist' }),
      'conv-1',
      { body: 'Replying to my own inbox' } as any,
    );

    expect(messages.insert).toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// listConversations() used to return the same conversation twice.
//
// The last-message lookup was a grouped subquery for max(created_at) joined
// back to `messages` ON that timestamp. A timestamp is not a key: any
// conversation whose two newest messages shared one matched twice, and the
// conversation appeared twice in the list — with the same id, which React
// reported as a duplicate key on /messages.
//
// Not a seed-data curiosity. Two messages written in the same transaction
// take the same now(), and any two sent close enough together tie at
// microsecond resolution.
// ----------------------------------------------------------------
describe('MessagingService.listConversations() — one row per conversation', () => {
  it('picks the last message with DISTINCT ON rather than by timestamp equality', async () => {
    const conversations = createMockQueryBuilder();
    conversations.mockResolve([]);
    const db = createMockDb({ 'conversations as c': conversations });

    // Records what the subquery builder was asked to do.
    const subquery = createMockQueryBuilder();
    subquery.distinctOn = jest.fn(() => subquery);
    subquery.as = jest.fn(() => subquery);
    const messagesBuilder = jest.fn(() => subquery);
    const originalDb = db;
    const wrapped: any = jest.fn((table: string) =>
      table === 'messages' ? messagesBuilder() : originalDb(table),
    );
    Object.assign(wrapped, originalDb);

    const service = new MessagingService(wrapped);
    await service.listConversations({ id: 'user-1', role: 'artist' } as any);

    // DISTINCT ON is what makes the fan-out impossible: the subquery yields
    // one row per conversation before the join ever happens.
    expect(subquery.distinctOn).toHaveBeenCalledWith('conversation_id');

    // And the ordering has to carry a real tiebreaker after created_at,
    // otherwise "which message" is whatever the planner returns first.
    const ordering = subquery.orderBy.mock.calls[0][0];
    expect(ordering).toEqual([
      { column: 'conversation_id' },
      { column: 'created_at', order: 'desc' },
      { column: 'id', order: 'desc' },
    ]);
  });

  it('no longer joins messages on a timestamp', async () => {
    // The shape of the bug: `.on('lm.created_at', 'lm_time.latest_at')`.
    const source = MessagingService.prototype.listConversations.toString();
    expect(source).not.toContain('latest_at');
  });
});
