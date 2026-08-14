import { Knex } from 'knex';

/**
 * The single source of truth for "does this user have paid access right now?".
 *
 * Several unrelated features need this answer — response shaping on artist
 * profiles, the identity-document requirement, messaging limits — and they
 * must all agree. Reimplementing the query at each call site is how they stop
 * agreeing, so every gate calls in here instead.
 */

export type PlanCode = 'day' | 'month' | 'year';

export type SubscriptionStatus =
  | 'ready'
  | 'active'
  | 'queued'
  | 'expired'
  | 'cancelled';

/** An active subscription joined to the policy flags of its plan. */
export interface ActiveSubscription {
  id: string;
  user_id: string;
  plan_code: PlanCode;
  status: SubscriptionStatus;
  activated_at: Date | null;
  starts_at: Date | null;
  expires_at: Date | null;
  /** From subscription_plans. Day passes are false — see migration 018. */
  requires_id_doc: boolean;
  /** From subscription_plans. NULL means uncapped; day passes are capped. */
  message_cap: number | null;
}

/**
 * The user's current subscription, or undefined if they have none.
 *
 * Note the expiry check. A row's status is set to 'expired' by a scheduled
 * job, so between the moment a subscription lapses and the next cron run
 * there is a window where status is still 'active' but the clock has run
 * out. Trusting status alone would hand out free access for the length of
 * that window, so the timestamp is verified on every read.
 *
 * The comparison uses the database clock rather than Node's. The scheduler
 * that writes these rows uses the same clock, and in production the API and
 * the database are not on the same machine — two clocks would eventually
 * disagree about who has access.
 *
 * An 'active' row always has expires_at set (it is written at activation and
 * at promotion). If one somehow does not, `NULL > now()` is NULL and the row
 * is excluded — access is denied rather than granted, which is the right way
 * for this to fail.
 */
export async function getActiveSubscription(
  db: Knex,
  userId: string,
): Promise<ActiveSubscription | undefined> {
  return db('subscriptions as s')
    .join('subscription_plans as p', 's.plan_code', 'p.code')
    .where('s.user_id', userId)
    .where('s.status', 'active')
    .whereRaw('s.expires_at > now()')
    .select(
      's.id',
      's.user_id',
      's.plan_code',
      's.status',
      's.activated_at',
      's.starts_at',
      's.expires_at',
      'p.requires_id_doc',
      'p.message_cap',
    )
    .first();
}

/** Convenience wrapper for gates that only need a yes/no. */
export async function hasActiveSubscription(
  db: Knex,
  userId: string,
): Promise<boolean> {
  return Boolean(await getActiveSubscription(db, userId));
}
