import { Knex } from 'knex';
import { aggregateValue } from './db.util';

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

/**
 * How many messages this subscription still allows, or null when the plan
 * is uncapped.
 *
 * The cap is per PERIOD, not per conversation and not lifetime: a day pass
 * buys 15 messages during its 24 hours, and buying a second pass buys 15
 * more. So the count is bounded below by when this subscription started,
 * which is also what makes re-buying work — the previous pass's messages
 * are outside the window and do not eat into the new one.
 *
 * `starts_at` and `activated_at` are written together at activation, so the
 * fallback between them is belt and braces. If BOTH are somehow null the
 * cap is treated as unenforceable and the send is allowed: that row is
 * malformed, and refusing a paying customer because of our own data bug is
 * a worse failure than briefly not counting. It cannot happen through the
 * activation path — the conditional UPDATE sets both.
 */
export async function remainingMessages(
  db: Knex,
  subscription: ActiveSubscription,
): Promise<number | null> {
  if (subscription.message_cap === null) return null;

  const periodStart = subscription.starts_at ?? subscription.activated_at;
  if (!periodStart) return null;

  const row = await db('messages')
    .where('sender_id', subscription.user_id)
    .where('created_at', '>=', periodStart)
    .count({ sent: '*' })
    .first();

  return Math.max(0, subscription.message_cap - aggregateValue(row, 'sent'));
}
