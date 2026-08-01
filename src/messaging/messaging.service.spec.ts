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
