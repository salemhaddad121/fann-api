import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { getActiveSubscription, PlanCode } from '../common/subscription.util';
import { CreatePaymentIntentDto, ReportTransferDto } from './dto/subscriptions.dto';

/**
 * Postgres NUMERIC arrives from node-postgres as a string, because a JS
 * number cannot represent every value NUMERIC can. Prices here are small
 * and fixed-scale, so converting is safe — but it has to be deliberate,
 * or `price_usd` reaches the frontend as "5.00" and quietly breaks any
 * arithmetic done on it.
 */
const toNumber = (value: unknown): number => Number(value);

/** Days before expiry that we warn on, per plan. Day passes get nothing. */
export const RENEWAL_REMINDER_DAYS: Record<PlanCode, number[]> = {
  year: [30, 7, 1],
  month: [3],
  day: [],
};

export const REMINDER_NOTIFICATION_TYPE = 'subscription_expiring';

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_code: PlanCode;
  status: string;
  payment_id: string | null;
  activated_at: Date | null;
  starts_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(@InjectConnection() private readonly db: Knex) {}

  // ================================================================
  // Reads
  // ================================================================

  async listPlans() {
    const rows = await this.db('subscription_plans')
      .where({ is_active: true })
      .orderBy('sort_order', 'asc')
      .select(
        'code',
        'price_usd',
        'duration_days',
        'requires_id_doc',
        'message_cap',
      );

    return rows.map((row) => ({ ...row, price_usd: toNumber(row.price_usd) }));
  }

  /**
   * Everything the account page and the dashboard banner need, in one
   * round trip: what is running, what is stacked behind it, how many
   * unactivated day-pass credits are banked, and what has already lapsed.
   */
  async getMine(userId: string) {
    const [active, rows] = await Promise.all([
      getActiveSubscription(this.db, userId),
      this.db('subscriptions as s')
        .join('subscription_plans as p', 's.plan_code', 'p.code')
        .where('s.user_id', userId)
        .orderBy('s.created_at', 'asc')
        .select(
          's.id',
          's.plan_code',
          's.status',
          's.payment_id',
          's.activated_at',
          's.starts_at',
          's.expires_at',
          's.created_at',
          'p.duration_days',
          'p.message_cap',
        ),
    ]);

    const queued = rows.filter((r) => r.status === 'queued');
    const credits = rows.filter((r) => r.status === 'ready');
    const history = rows
      .filter((r) => r.status === 'expired' || r.status === 'cancelled')
      .reverse();

    return {
      active: active ?? null,
      queued,
      credits: { available: credits.length, rows: credits },
      history,
    };
  }

  async listMyPayments(userId: string) {
    const rows = await this.db('payments')
      .where({ planner_id: userId })
      .orderBy('created_at', 'desc')
      .select(
        'id',
        'plan_code',
        'quantity',
        'amount_usd',
        'currency',
        'status',
        'provider',
        'transfer_service',
        'reference_code',
        'rejection_reason',
        'created_at',
      );

    return rows.map((row) => ({ ...row, amount_usd: toNumber(row.amount_usd) }));
  }

  // ================================================================
  // Purchase
  // ================================================================

  /**
   * Creates a purchase intent. Nothing is granted here — the subscription
   * rows are minted only once the payment is confirmed, by mintForPayment().
   *
   * period_start / period_end are deliberately left NULL. They used to be
   * required (migration 001 treated a payment AS a subscription period),
   * but a day-pass credit has no period until someone activates it, and
   * guessing one here would put a wrong date in front of the buyer.
   */
  async createPaymentIntent(userId: string, dto: CreatePaymentIntentDto) {
    const quantity = dto.quantity ?? 1;

    const plan = await this.db('subscription_plans')
      .where({ code: dto.planCode, is_active: true })
      .first();
    if (!plan) throw new NotFoundException('That plan is not available.');

    // Priced server-side from the plan table. Taking an amount from the
    // request would let the buyer name their own price.
    const amountUsd = toNumber(plan.price_usd) * quantity;

    const [payment] = await this.db('payments')
      .insert({
        planner_id: userId,
        plan_code: dto.planCode,
        quantity,
        amount_usd: amountUsd,
        currency: 'USD',
        provider: 'manual',
        status: 'pending',
        transfer_service: dto.transferService ?? null,
        reference_code: dto.referenceCode ?? null,
      })
      .returning(['id', 'plan_code', 'quantity', 'amount_usd', 'currency', 'status', 'created_at']);

    const user = await this.db('users').where({ id: userId }).select('account_code').first();

    return {
      ...payment,
      amount_usd: toNumber(payment.amount_usd),
      // The reconciliation key the buyer must quote on the transfer. It is
      // hidden from the profile UI but has to be prominent here.
      account_code: user?.account_code ?? null,
    };
  }

  /** Buyer reports the transfer reference after paying. */
  async reportTransfer(userId: string, paymentId: string, dto: ReportTransferDto) {
    const updated = await this.db('payments')
      .where({ id: paymentId, planner_id: userId, status: 'pending' })
      .update({
        transfer_service: dto.transferService,
        reference_code: dto.referenceCode,
        updated_at: this.db.fn.now(),
      })
      .returning(['id', 'status']);

    if (!updated.length) {
      throw new NotFoundException('No pending payment found to update.');
    }
    return { message: 'Transfer details recorded. An admin will confirm shortly.' };
  }

  // ================================================================
  // Activation
  // ================================================================

  /**
   * Starts the clock on a banked day-pass credit.
   *
   * Credits are sold ahead of time and sit in 'ready' indefinitely, so this
   * is the moment the 24 hours begins — not the moment of payment. That is
   * the whole reason day access is modelled as credits: confirmation is
   * manual here and can take hours, and nobody should lose a third of what
   * they bought waiting for an admin.
   */
  async activate(userId: string, subscriptionId: string) {
    const credit = await this.db('subscriptions')
      .where({ id: subscriptionId, user_id: userId })
      .first();

    if (!credit) throw new NotFoundException('Subscription not found.');
    if (credit.status !== 'ready') {
      throw new BadRequestException(
        credit.status === 'active'
          ? 'That pass is already running.'
          : `That pass cannot be activated (it is ${credit.status}).`,
      );
    }

    // Refuse to burn a credit that would be wasted. Access is not additive
    // — a running month already unlocks everything a day pass would — so
    // activating now would spend it for nothing.
    const running = await getActiveSubscription(this.db, userId);
    if (running) {
      throw new ConflictException(
        running.plan_code === 'day'
          ? 'You already have a day pass running. Wait for it to finish before starting another.'
          : `Your ${running.plan_code} subscription is already active, so this day pass would be wasted. It will keep until you need it.`,
      );
    }

    const plan = await this.db('subscription_plans').where({ code: credit.plan_code }).first();
    if (!plan) throw new NotFoundException('Plan not found for this subscription.');

    try {
      // Conditional update, not a read-then-write: the WHERE clause carries
      // status = 'ready', so two simultaneous requests cannot both spend the
      // same credit. The loser updates zero rows.
      const updated = await this.db('subscriptions')
        .where({ id: subscriptionId, user_id: userId, status: 'ready' })
        .update({
          status: 'active',
          activated_at: this.db.fn.now(),
          starts_at: this.db.fn.now(),
          expires_at: this.db.raw("now() + (? || ' days')::interval", [plan.duration_days]),
          updated_at: this.db.fn.now(),
        })
        .returning(['id', 'plan_code', 'status', 'starts_at', 'expires_at']);

      if (!updated.length) {
        throw new ConflictException('That pass has already been used.');
      }
      return updated[0];
    } catch (err) {
      // one_active_sub_per_user firing means another activation won the race
      // between the check above and this write.
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('You already have a subscription running.');
      }
      throw err;
    }
  }

  // ================================================================
  // Minting — the one place subscriptions are created from a payment
  // ================================================================

  /**
   * Turns a confirmed payment into subscription rows.
   *
   * There is exactly one of these on purpose. The admin confirm button
   * calls it today and the payment-provider webhook will call it in Wave 7;
   * if each grew its own copy of the stacking rules they would drift, and
   * the bug would only ever show up in production against real money.
   *
   * Idempotent by design — it refuses to mint twice for the same payment.
   * Webhook providers retry, and a retry must not hand out a second year.
   */
  async mintForPayment(
    paymentId: string,
    executor: Knex | Knex.Transaction = this.db,
  ): Promise<{ minted: number; alreadyMinted: boolean; rows: SubscriptionRow[] }> {
    const payment = await executor('payments').where({ id: paymentId }).first();
    if (!payment) throw new NotFoundException('Payment not found.');

    // Payments predating the subscription model (seed data, migration 009)
    // carry no plan_code. There is nothing to mint and that is not an error.
    if (!payment.plan_code) {
      return { minted: 0, alreadyMinted: false, rows: [] };
    }

    const existing = await executor('subscriptions')
      .where({ payment_id: paymentId })
      .select('id');
    if (existing.length > 0) {
      this.logger.warn(
        `[Subscriptions] Payment ${paymentId} already minted ${existing.length} row(s); skipping.`,
      );
      return { minted: 0, alreadyMinted: true, rows: [] };
    }

    const plan = await executor('subscription_plans').where({ code: payment.plan_code }).first();
    if (!plan) throw new NotFoundException('Plan not found for this payment.');

    const userId = payment.planner_id;
    const quantity = payment.quantity ?? 1;

    // Day passes are credits, always. They never go straight to active and
    // never join the queue — the buyer decides when each one starts.
    if (plan.code === 'day') {
      const rows = await executor('subscriptions')
        .insert(
          Array.from({ length: quantity }, () => ({
            user_id: userId,
            plan_code: plan.code,
            payment_id: paymentId,
            status: 'ready',
          })),
        )
        .returning('*');
      return { minted: rows.length, alreadyMinted: false, rows };
    }

    return this.mintDatedPlan(executor, {
      userId,
      paymentId,
      planCode: plan.code,
      durationDays: plan.duration_days,
      quantity,
    });
  }

  /**
   * Month and year purchases. The first one starts immediately if nothing
   * is running; anything beyond that stacks behind what is already there.
   */
  private async mintDatedPlan(
    executor: Knex | Knex.Transaction,
    input: {
      userId: string;
      paymentId: string;
      planCode: PlanCode;
      durationDays: number;
      quantity: number;
    },
  ) {
    const { userId, paymentId, planCode, durationDays, quantity } = input;

    const active = await executor('subscriptions')
      .where({ user_id: userId, status: 'active' })
      .first();

    const queued = await executor('subscriptions as s')
      .join('subscription_plans as p', 's.plan_code', 'p.code')
      .where('s.user_id', userId)
      .where('s.status', 'queued')
      .orderBy('s.created_at', 'asc')
      .select('s.id', 'p.duration_days');

    // Where the existing chain runs out. Used only to project a start date
    // for display — the authoritative expires_at is computed at promotion,
    // which is what lets the chain survive a cancellation or an admin fix.
    //
    // Queued rows with no active row ahead of them is a transient state
    // between a subscription lapsing and the promotion cron running. New
    // purchases still queue rather than jumping the line.
    let chainEnd: Date | null = null;
    if (active?.expires_at) {
      chainEnd = new Date(active.expires_at);
    } else if (queued.length > 0) {
      chainEnd = new Date();
    }
    for (const row of queued) {
      chainEnd = addDays(chainEnd ?? new Date(), row.duration_days);
    }

    const rows: SubscriptionRow[] = [];

    for (let i = 0; i < quantity; i++) {
      if (chainEnd === null) {
        const [row] = await executor('subscriptions')
          .insert({
            user_id: userId,
            plan_code: planCode,
            payment_id: paymentId,
            status: 'active',
            starts_at: executor.fn.now(),
            expires_at: executor.raw("now() + (? || ' days')::interval", [durationDays]),
          })
          .returning('*');
        rows.push(row);
        // Read the expiry back rather than recomputing it in JS, so the
        // chain is anchored to the database clock.
        chainEnd = row?.expires_at ? new Date(row.expires_at) : addDays(new Date(), durationDays);
      } else {
        const [row] = await executor('subscriptions')
          .insert({
            user_id: userId,
            plan_code: planCode,
            payment_id: paymentId,
            status: 'queued',
            starts_at: chainEnd,
            expires_at: null,
          })
          .returning('*');
        rows.push(row);
        chainEnd = addDays(chainEnd, durationDays);
      }
    }

    return { minted: rows.length, alreadyMinted: false, rows };
  }

  // ================================================================
  // Scheduled maintenance
  // ================================================================

  /**
   * Expires whatever has run out, then promotes the next queued period for
   * anyone left without one.
   *
   * Promotion is what computes expires_at for a queued row. Doing it here
   * rather than at purchase time is what makes a stacked plan start from
   * when it actually begins, not from a date guessed weeks earlier.
   */
  async expireAndPromote(): Promise<{
    expired: { id: string; user_id: string; plan_code: PlanCode }[];
    promoted: { id: string; user_id: string; plan_code: PlanCode; expires_at: Date }[];
  }> {
    const expired = await this.db('subscriptions')
      .where('status', 'active')
      .whereRaw('expires_at <= now()')
      .update({ status: 'expired', updated_at: this.db.fn.now() })
      .returning(['id', 'user_id', 'plan_code']);

    // Everyone holding a queued period with nothing running. Derived from
    // current state rather than from the rows just expired, so a promotion
    // missed by an earlier failed run gets picked up on the next pass.
    const waiting = await this.db('subscriptions as s')
      .whereRaw(
        "s.status = 'queued' AND NOT EXISTS (SELECT 1 FROM subscriptions a WHERE a.user_id = s.user_id AND a.status = 'active')",
      )
      .distinct('s.user_id')
      .select('s.user_id');

    const promoted: { id: string; user_id: string; plan_code: PlanCode; expires_at: Date }[] = [];

    for (const { user_id: userId } of waiting) {
      try {
        const next = await this.db('subscriptions as s')
          .join('subscription_plans as p', 's.plan_code', 'p.code')
          .where('s.user_id', userId)
          .where('s.status', 'queued')
          .orderBy('s.created_at', 'asc')
          .select('s.id', 's.plan_code', 'p.duration_days')
          .first();
        if (!next) continue;

        const [row] = await this.db('subscriptions')
          .where({ id: next.id, status: 'queued' })
          .update({
            status: 'active',
            starts_at: this.db.fn.now(),
            expires_at: this.db.raw("now() + (? || ' days')::interval", [next.duration_days]),
            updated_at: this.db.fn.now(),
          })
          .returning(['id', 'user_id', 'plan_code', 'expires_at']);

        if (row) promoted.push(row);
      } catch (err) {
        // One user's promotion failing must not stop everyone else's.
        this.logger.error(`[Subscriptions] Promotion failed for user ${userId}`, err);
      }
    }

    return { expired, promoted };
  }

  /**
   * Subscriptions approaching expiry, at the thresholds their plan warrants.
   *
   * Deduplicated against the notifications already sent rather than against
   * a column on the subscription. The notification IS the record of having
   * warned someone, so asking it directly cannot disagree with what the user
   * actually saw — and a daily cron that drifts by a few hours re-sending
   * the same warning is exactly the kind of thing users report as spam.
   */
  async findDueRenewalReminders(): Promise<
    { subscription_id: string; user_id: string; plan_code: PlanCode; days: number; expires_at: Date }[]
  > {
    const active = await this.db('subscriptions as s')
      .where('s.status', 'active')
      .whereRaw('s.expires_at > now()')
      .select('s.id', 's.user_id', 's.plan_code', 's.expires_at');

    const candidates: {
      subscription_id: string;
      user_id: string;
      plan_code: PlanCode;
      days: number;
      expires_at: Date;
    }[] = [];

    for (const sub of active) {
      const thresholds = RENEWAL_REMINDER_DAYS[sub.plan_code as PlanCode] ?? [];
      if (thresholds.length === 0) continue;

      const daysLeft = wholeDaysUntil(new Date(sub.expires_at));
      // Smallest threshold still at or above the days remaining. Ascending
      // order matters: with 6 days left and thresholds 30/7/1, the answer is
      // 7, not 30. Scanning largest-first would fire the "a month to go"
      // warning six days out and then never match the 7-day one, because
      // dedup keys on the threshold that was sent.
      //
      // Taking the nearest threshold at or above also means a cron that
      // misses a day still catches the window on its next run.
      const threshold = [...thresholds]
        .sort((a, b) => a - b)
        .find((t) => daysLeft <= t);
      if (threshold === undefined) continue;

      candidates.push({
        subscription_id: sub.id,
        user_id: sub.user_id,
        plan_code: sub.plan_code,
        days: threshold,
        expires_at: sub.expires_at,
      });
    }

    if (candidates.length === 0) return [];

    const alreadySent = await this.db('notifications')
      .where('type', REMINDER_NOTIFICATION_TYPE)
      .whereIn(
        'user_id',
        candidates.map((c) => c.user_id),
      )
      .select('data');

    const sentKeys = new Set(
      alreadySent.map((n) => {
        const data = typeof n.data === 'string' ? JSON.parse(n.data) : n.data;
        return `${data?.subscription_id}:${data?.days}`;
      }),
    );

    return candidates.filter(
      (c) => !sentKeys.has(`${c.subscription_id}:${c.days}`),
    );
  }
}

/** Projection helper — display dates only, never an authoritative expiry. */
function addDays(from: Date, days: number): Date {
  const next = new Date(from);
  next.setDate(next.getDate() + days);
  return next;
}

function wholeDaysUntil(target: Date): number {
  const ms = target.getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}
