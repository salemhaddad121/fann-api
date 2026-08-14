import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

// AdminService now mirrors status decisions onto the verification record;
// these tests are about the status logic itself, so it's stubbed.
const verificationStub = { recordAdminDecision: jest.fn() };

// Minting lives in SubscriptionsService and has its own tests. These cases
// are about admin decision logic, so it is stubbed.
const subscriptionsStub = { mintForPayment: jest.fn().mockResolvedValue({ minted: 0 }) };

const baseFlag = {
  id: 'flag-1',
  status: 'open',
  reporter_id: 'reporter-1',
  reason: 'Inappropriate content',
};

describe('AdminService.resolveFlag()', () => {
  it('rejects resolving a flag that is already resolved', async () => {
    const flags = createMockQueryBuilder();
    flags.first.mockResolvedValueOnce({ ...baseFlag, status: 'dismissed' });
    const db = createMockDb({ flags });
    const service = new AdminService(db, verificationStub as any, subscriptionsStub as any);

    await expect(
      service.resolveFlag('admin-1', 'flag-1', { decision: 'dismissed' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('always notifies the reporter, regardless of decision', async () => {
    const flags = createMockQueryBuilder();
    flags.first.mockResolvedValueOnce({ ...baseFlag, target_type: 'profile', target_id: 'user-9' });
    const notifications = createMockQueryBuilder();
    const auditLog = createMockQueryBuilder();
    const db = createMockDb({ flags, notifications, audit_log: auditLog });
    const service = new AdminService(db, verificationStub as any, subscriptionsStub as any);

    await service.resolveFlag('admin-1', 'flag-1', { decision: 'dismissed' } as any);

    expect(notifications.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'reporter-1', type: 'flag_resolved' }),
    );
  });

  it('does NOT notify the flagged party when a flag is merely dismissed', async () => {
    const flags = createMockQueryBuilder();
    flags.first.mockResolvedValueOnce({ ...baseFlag, target_type: 'profile', target_id: 'user-9' });
    const notifications = createMockQueryBuilder();
    const auditLog = createMockQueryBuilder();
    const db = createMockDb({ flags, notifications, audit_log: auditLog });
    const service = new AdminService(db, verificationStub as any, subscriptionsStub as any);

    await service.resolveFlag('admin-1', 'flag-1', { decision: 'dismissed' } as any);

    // Only the reporter notification (1 call), never one for user-9.
    expect(notifications.insert).toHaveBeenCalledTimes(1);
    expect(notifications.insert).not.toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-9' }),
    );
  });

  it('resolves a "profile" target directly — target_id already is the user id', async () => {
    const flags = createMockQueryBuilder();
    flags.first.mockResolvedValueOnce({ ...baseFlag, target_type: 'profile', target_id: 'user-9' });
    const notifications = createMockQueryBuilder();
    const auditLog = createMockQueryBuilder();
    const db = createMockDb({ flags, notifications, audit_log: auditLog });
    const service = new AdminService(db, verificationStub as any, subscriptionsStub as any);

    await service.resolveFlag('admin-1', 'flag-1', { decision: 'actioned' } as any);

    expect(notifications.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-9', type: 'flag_actioned' }),
    );
  });

  it("resolves a 'message' target via the message's sender_id", async () => {
    const flags = createMockQueryBuilder();
    flags.first.mockResolvedValueOnce({ ...baseFlag, target_type: 'message', target_id: 'msg-5' });
    const messages = createMockQueryBuilder();
    messages.first.mockResolvedValueOnce({ sender_id: 'user-7' });
    const notifications = createMockQueryBuilder();
    const auditLog = createMockQueryBuilder();
    const db = createMockDb({ flags, messages, notifications, audit_log: auditLog });
    const service = new AdminService(db, verificationStub as any, subscriptionsStub as any);

    await service.resolveFlag('admin-1', 'flag-1', { decision: 'actioned' } as any);

    expect(notifications.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-7', type: 'flag_actioned' }),
    );
  });

  it('resolves a "conversation" target to whichever participant is not the reporter', async () => {
    const flags = createMockQueryBuilder();
    flags.first.mockResolvedValueOnce({
      ...baseFlag,
      target_type: 'conversation',
      target_id: 'conv-3',
      reporter_id: 'planner-1', // the reporter is the planner in this conversation
    });
    const conversations = createMockQueryBuilder();
    conversations.first.mockResolvedValueOnce({ artist_id: 'artist-1', planner_id: 'planner-1' });
    const notifications = createMockQueryBuilder();
    const auditLog = createMockQueryBuilder();
    const db = createMockDb({ flags, conversations, notifications, audit_log: auditLog });
    const service = new AdminService(db, verificationStub as any, subscriptionsStub as any);

    await service.resolveFlag('admin-1', 'flag-1', { decision: 'actioned' } as any);

    // Reporter is the planner, so the artist is the one actioned/notified.
    expect(notifications.insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'artist-1', type: 'flag_actioned' }),
    );
  });
});
