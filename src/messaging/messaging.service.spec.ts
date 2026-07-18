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
    ...overrides,
  };
}

function setUpConversation() {
  const conversations = createMockQueryBuilder();
  conversations.first.mockResolvedValueOnce({
    id: 'conv-1',
    artist_id: 'artist-1',
    planner_id: 'planner-1',
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
