import { buildMaintenanceNotifications } from './scheduler.service';

const ended = { id: 'old-1', user_id: 'user-1', plan_code: 'day' };
const next = {
  id: 'new-1',
  user_id: 'user-1',
  plan_code: 'month',
  expires_at: new Date('2026-09-14'),
};

describe('buildMaintenanceNotifications()', () => {
  it('collapses an expiry and its immediate promotion into one message', () => {
    // Nothing was interrupted, so telling the user their subscription
    // ended and then that a new one started describes a gap in service
    // that never happened.
    const result = buildMaintenanceNotifications([ended], [next]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('subscription_rolled_over');
    expect(result[0].title).toBe('Your day plan ended and your month plan started');
    expect(result[0].data).toMatchObject({
      subscription_id: 'new-1',
      plan_code: 'month',
      previous_subscription_id: 'old-1',
      previous_plan_code: 'day',
    });
  });

  it('reports a plain expiry when nothing was queued behind it', () => {
    const result = buildMaintenanceNotifications([ended], []);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('subscription_expired');
  });

  it('reports a promotion with no matching expiry on its own', () => {
    // The recovery case: an earlier run failed to promote and this one
    // caught up, so the user really did lose access in between.
    const result = buildMaintenanceNotifications([], [next]);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('subscription_started');
  });

  it('does not let one user\'s promotion cancel another user\'s expiry', () => {
    const otherUserExpiry = { id: 'old-2', user_id: 'user-2', plan_code: 'month' };

    const result = buildMaintenanceNotifications([ended, otherUserExpiry], [next]);

    expect(result).toHaveLength(2);
    expect(result.find((n) => n.userId === 'user-1')?.type).toBe('subscription_rolled_over');
    expect(result.find((n) => n.userId === 'user-2')?.type).toBe('subscription_expired');
  });

  it('returns nothing when the sweep changed nothing', () => {
    expect(buildMaintenanceNotifications([], [])).toEqual([]);
  });
});
