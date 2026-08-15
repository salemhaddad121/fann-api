import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { VerificationService } from '../verification/verification.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { IdentityDocumentsService } from '../verification/identity-documents.service';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { aggregateValue } from '../common/db.util';
import {
  AuditLogDto,
  CreateCategoryDto,
  CreateCategoryGroupDto,
  ListUsersDto,
  PaginationDto,
  ResolveFlagDto,
  ReviewIdDocumentDto,
  ReviewPaymentDto,
  UpdateCategoryDto,
  UpdateCategoryGroupDto,
  UpdateUserStatusDto,
} from './dto/admin.dto';

const BCRYPT_ROUNDS = 12;

/**
 * Whether a user has BOTH identity artefacts approved.
 *
 * Duplicated from IdentityDocumentsService.hasCompleteVerification()
 * on purpose: this one runs inside the review transaction, so it sees the
 * row that was just updated. Calling the service would read through a
 * different connection and miss it.
 */
async function hasBothApproved(trx: Knex.Transaction, userId: string): Promise<boolean> {
  const rows = await trx('id_documents')
    .where({ user_id: userId, status: 'approved' })
    .select('kind');

  const approved = new Set(rows.map((r) => r.kind as string));
  return approved.has('id_document') && approved.has('selfie');
}


// Ambiguous characters (0/O, 1/l/I) are left out because these get read out
// over the phone. Guarantees one of each class so the result always passes
// the same complexity rule the signup form enforces.
function generateTemporaryPassword(): string {
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = lower + upper + digits;

  const pick = (set: string) => set[randomInt(set.length)];
  const chars = [pick(lower), pick(upper), pick(digits)];
  while (chars.length < 12) chars.push(pick(all));

  // Fisher-Yates, so the guaranteed characters aren't always in front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

@Injectable()
export class AdminService {
  constructor(
    @InjectConnection() private readonly db: Knex,
    private readonly verificationService: VerificationService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly identityDocuments: IdentityDocumentsService,
  ) {}

  // ================================================================
  // USERS
  // ================================================================

  async listUsers(dto: ListUsersDto) {
    const { page = 1, limit = 30 } = dto;
    const offset = (page - 1) * limit;

    let query = this.db('users as u')
      .leftJoin('artist_profiles as ap',  'ap.user_id', 'u.id')
      .leftJoin('planner_profiles as pp', 'pp.user_id', 'u.id')
      .select(
        'u.id',
        'u.email',
        'u.phone',
        'u.role',
        'u.status',
        'u.account_code',
        'u.email_verified_at',
        'u.phone_verified_at',
        'u.last_login_at',
        'u.created_at',
        'u.deleted_at',
        this.db.raw(`COALESCE(ap.display_name, pp.display_name) AS display_name`),
        this.db.raw(`COALESCE(ap.is_verified, FALSE) AS is_verified`),
        this.db.raw(`COALESCE(ap.thumbnail_url, pp.thumbnail_url) AS thumbnail_url`),
      );

    if (dto.role) query = query.where('u.role', dto.role);

    // The five states the admin UI shows are mutually exclusive, so a
    // soft-deleted account only matches 'deleted' — never its underlying
    // status. That mirrors the badge, which reads "Deleted" whenever
    // deleted_at is set no matter what status says.
    if (dto.status === 'deleted') {
      query = query.whereNotNull('u.deleted_at');
    } else if (dto.status) {
      query = query.where('u.status', dto.status).whereNull('u.deleted_at');
    }
    if (dto.q) {
      query = query.where((b) =>
        b
          .whereILike('u.email', `%${dto.q}%`)
          .orWhereILike('u.account_code', `%${dto.q}%`)
          .orWhereILike('ap.display_name', `%${dto.q}%`)
          .orWhereILike('pp.display_name', `%${dto.q}%`),
      );
    }

    const countQuery = query.clone().clearSelect().clearOrder().count('u.id as total').first();
    const [countRow, rows] = await Promise.all([
      countQuery,
      query.orderBy('u.created_at', 'desc').limit(limit).offset(offset),
    ]);
    const total = aggregateValue(countRow, 'total');

    return {
      data: rows,
      meta: { total: Number(total), page, limit, pages: Math.ceil(Number(total) / limit) },
    };
  }

  async getUser(userId: string) {
    const user = await this.db('users as u')
      .leftJoin('artist_profiles as ap',  'ap.user_id', 'u.id')
      .leftJoin('planner_profiles as pp', 'pp.user_id', 'u.id')
      .leftJoin('id_documents as doc',    'doc.user_id', 'u.id')
      .where('u.id', userId)
      .select(
        'u.*',
        this.db.raw(`COALESCE(ap.display_name, pp.display_name) AS display_name`),
        this.db.raw(`row_to_json(ap.*) AS artist_profile`),
        this.db.raw(`row_to_json(pp.*) AS planner_profile`),
        'doc.status as doc_status',
        'doc.rejection_reason as doc_rejection_reason',
        'doc.reviewed_at as doc_reviewed_at',
      )
      .first();

    if (!user) throw new NotFoundException('User not found.');

    // Latest payment for planners
    if (user.role === 'planner') {
      user.latest_payment = await this.db('payments')
        .where({ planner_id: userId })
        .orderBy('created_at', 'desc')
        .first();
    }

    return user;
  }

  async updateUserStatus(adminId: string, userId: string, dto: UpdateUserStatusDto) {
    const user = await this.db('users').where({ id: userId }).first();
    if (!user) throw new NotFoundException('User not found.');
    if (user.role === 'admin') throw new BadRequestException('Cannot change status of admin accounts.');

    // The artist identity gate. Activating is what publishes a profile —
    // every public artist query filters on u.status = 'active' — so this is
    // the one place that decision is made, and therefore the only place
    // worth enforcing it.
    //
    // Only on the transition INTO active, and only for artists. Bookers are
    // deliberately ungated, and an already-active artist is not re-checked:
    // this rule arrived after accounts were live, and retroactively
    // delisting them would be a far larger decision than adding a gate.
    if (
      dto.status === 'active' &&
      user.role === 'artist' &&
      user.status !== 'active' &&
      !(await this.identityDocuments.hasCompleteVerification(userId))
    ) {
      throw new BadRequestException(
        'This artist has not passed identity verification. Both the ID document and the selfie must be approved before the account can go live.',
      );
    }

    await this.db('users').where({ id: userId }).update({ status: dto.status });

    // Map status change → audit action
    const actionMap = {
      active:    'user.approved',
      suspended: 'user.suspended',
      banned:    'user.banned',
    } as const;

    await this.writeAudit(adminId, actionMap[dto.status], userId, dto.note);

    // Mirror the decision onto the verification record. 'active' is the
    // approval; suspended/banned settle it as failed. Anything else leaves
    // the record pending.
    await this.verificationService.recordAdminDecision(
      userId,
      adminId,
      dto.status === 'active',
      dto.note,
    );

    const titleMap = {
      active:    'Your account has been approved',
      suspended: 'Your account has been suspended',
      banned:    'Your account has been banned',
    } as const;
    const typeMap = {
      active:    'account_approved',
      suspended: 'account_suspended',
      banned:    'account_banned',
    } as const;
    await this.notify(userId, typeMap[dto.status], titleMap[dto.status], {
      ...(dto.note && { note: dto.note }),
    });

    return { message: `User status updated to ${dto.status}.` };
  }

  // Admin-initiated password reset for phone/WhatsApp support, where the
  // usual emailed reset link isn't practical.
  //
  // The generated password is returned to the admin exactly once and is
  // never stored in plaintext — only the bcrypt hash is written, and the
  // audit row deliberately records that a reset happened without recording
  // the value. Any existing refresh token is left alone by design here;
  // changing the password does not itself end other sessions.
  async resetUserPassword(adminId: string, userId: string, note?: string) {
    const user = await this.db('users').where({ id: userId }).first();
    if (!user) throw new NotFoundException('User not found.');
    if (user.role === 'admin') {
      throw new BadRequestException('Cannot reset the password of an admin account.');
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);
    await this.db('users').where({ id: userId }).update({
      password_hash: passwordHash,
      updated_at:    this.db.fn.now(),
    });

    await this.writeAudit(adminId, 'user_password_reset', userId, note);
    await this.notify(userId, 'password_reset_by_admin', 'Your password was reset', {
      ...(note && { note }),
    });

    return { temporaryPassword };
  }

  // ================================================================
  // ID DOCUMENTS
  // ================================================================

  async listPendingDocuments(dto: PaginationDto) {
    const { page = 1, limit = 30 } = dto;
    const offset = (page - 1) * limit;

    const query = this.db('id_documents as doc')
      .join('users as u', 'u.id', 'doc.user_id')
      .leftJoin('artist_profiles as ap',  'ap.user_id', 'u.id')
      .leftJoin('planner_profiles as pp', 'pp.user_id', 'u.id')
      .where('doc.status', 'pending')
      .select(
        'doc.id',
        'doc.user_id',
        'doc.status',
        // Which artefact this is. Without it a reviewer cannot tell an ID
        // scan from a selfie in the queue, and the two are judged
        // differently — one is checked for validity, the other for whether
        // it is the same person.
        'doc.kind',
        'doc.uploaded_at',
        'u.email',
        'u.role',
        'u.account_code',
        'u.status as user_status',
        this.db.raw(`COALESCE(ap.display_name, pp.display_name) AS display_name`),
      )
      .orderBy('doc.uploaded_at', 'asc'); // oldest first — FIFO review queue

    const [countRow, rows] = await Promise.all([
      query.clone().clearSelect().clearOrder().count('doc.id as total').first(),
      query.limit(limit).offset(offset),
    ]);
    const total = aggregateValue(countRow, 'total');

    return {
      data: rows,
      meta: { total: Number(total), page, limit, pages: Math.ceil(Number(total) / limit) },
    };
  }

  async reviewDocument(adminId: string, docId: string, dto: ReviewIdDocumentDto) {
    const doc = await this.db('id_documents').where({ id: docId }).first();
    if (!doc) throw new NotFoundException('ID document not found.');
    if (doc.status !== 'pending') {
      throw new BadRequestException(`Document has already been ${doc.status}.`);
    }
    if (dto.decision === 'rejected' && !dto.rejectionReason) {
      throw new BadRequestException('A rejection reason is required.');
    }

    await this.db.transaction(async (trx) => {
      await trx('id_documents').where({ id: docId }).update({
        status:           dto.decision,
        rejection_reason: dto.rejectionReason ?? null,
        reviewed_by:      adminId,
        reviewed_at:      trx.fn.now(),
      });

      // The verified badge means "identity confirmed", which now takes BOTH
      // an ID document and a selfie. Flipping it on the first approval
      // would badge an artist who has only submitted half of it — and the
      // badge is exactly what a booker reads as assurance.
      //
      // Rejecting either one clears it, so a badge cannot survive the
      // document it was based on being withdrawn.
      const verified =
        dto.decision === 'approved' &&
        (await hasBothApproved(trx, doc.user_id));

      await trx('artist_profiles')
        .where({ user_id: doc.user_id })
        .update({ is_verified: verified });
    });

    const auditAction =
      dto.decision === 'approved' ? 'id_doc.approved' : 'id_doc.rejected';

    await this.writeAudit(adminId, auditAction, doc.user_id, dto.rejectionReason, {
      doc_id: docId,
      ...(dto.rejectionReason && { rejection_reason: dto.rejectionReason }),
    });

    const titleMap = {
      approved: 'Your ID has been verified',
      rejected: 'Your ID verification was rejected',
    } as const;
    const typeMap = { approved: 'id_verified', rejected: 'id_rejected' } as const;
    await this.notify(doc.user_id, typeMap[dto.decision], titleMap[dto.decision], {
      ...(dto.rejectionReason && { rejection_reason: dto.rejectionReason }),
    });

    return { message: `Document ${dto.decision}.` };
  }

  // ================================================================
  // PAYMENTS
  // ================================================================

  async listPendingPayments(dto: PaginationDto) {
    const { page = 1, limit = 30 } = dto;
    const offset = (page - 1) * limit;

    const query = this.db('payments as p')
      .join('users as u',          'u.id', 'p.planner_id')
      .leftJoin('planner_profiles as pp', 'pp.user_id', 'u.id')
      // Anything still awaiting a decision. Since intents moved to
      // awaiting_provider, filtering on 'pending' alone would leave the
      // queue permanently empty.
      .whereIn('p.status', ['pending', 'awaiting_provider'])
      .select(
        'p.id',
        'p.planner_id',
        'p.amount_usd',
        // What the admin is actually confirming. Without these the panel
        // shows a dollar amount with no indication of what it buys, and a
        // pack of ten day passes looks identical to a single year.
        'p.plan_code',
        'p.quantity',
        'p.currency',
        'p.provider',
        'p.transfer_service',
        'p.reference_code',
        'p.period_start',
        'p.period_end',
        'p.created_at',
        'u.email',
        'u.account_code',
        'pp.display_name',
        'pp.company_name',
      )
      .orderBy('p.created_at', 'asc');

    const [countRow, rows] = await Promise.all([
      query.clone().clearSelect().clearOrder().count('p.id as total').first(),
      query.limit(limit).offset(offset),
    ]);
    const total = aggregateValue(countRow, 'total');

    return {
      data: rows,
      meta: { total: Number(total), page, limit, pages: Math.ceil(Number(total) / limit) },
    };
  }

  async reviewPayment(adminId: string, paymentId: string, dto: ReviewPaymentDto) {
    const payment = await this.db('payments').where({ id: paymentId }).first();
    if (!payment) throw new NotFoundException('Payment not found.');
    // Both states mean "awaiting a decision". awaiting_provider is where an
    // intent sits once the buyer has been given somewhere to pay, which is
    // now every manual payment — checking for 'pending' alone would make
    // the confirm button reject everything.
    if (payment.status !== 'pending' && payment.status !== 'awaiting_provider') {
      throw new BadRequestException(`Payment has already been ${payment.status}.`);
    }
    if (dto.decision === 'rejected' && !dto.rejectionReason) {
      throw new BadRequestException('A rejection reason is required.');
    }

    // The status change and the minting share a transaction on purpose. If
    // minting failed on its own the payment would sit marked 'confirmed'
    // with nothing granted — money taken, no access, and no signal that
    // anything went wrong. Either both land or neither does.
    let minted = 0;
    await this.db.transaction(async (trx) => {
      await trx('payments').where({ id: paymentId }).update({
        status:           dto.decision,
        rejection_reason: dto.rejectionReason ?? null,
        confirmed_by:     dto.decision === 'confirmed' ? adminId : null,
        confirmed_at:     dto.decision === 'confirmed' ? this.db.fn.now() : null,
      });

      if (dto.decision === 'confirmed') {
        // Same method the payment webhook calls in Wave 7. One
        // implementation of the stacking rules, two callers.
        const result = await this.subscriptionsService.mintForPayment(paymentId, trx);
        minted = result.minted;
      }
    });

    const auditAction =
      dto.decision === 'confirmed' ? 'payment.confirmed' : 'payment.rejected';

    await this.writeAudit(adminId, auditAction, payment.planner_id, dto.rejectionReason, {
      payment_id:       paymentId,
      transfer_service: payment.transfer_service,
      reference:        payment.reference_code,
      ...(payment.plan_code && { plan_code: payment.plan_code, quantity: payment.quantity }),
      ...(minted > 0 && { subscriptions_minted: minted }),
      ...(dto.rejectionReason && { rejection_reason: dto.rejectionReason }),
    });

    const titleMap = {
      confirmed: 'Your payment was confirmed',
      rejected:  'Your payment was rejected',
    } as const;
    const typeMap = { confirmed: 'payment_confirmed', rejected: 'payment_rejected' } as const;
    await this.notify(payment.planner_id, typeMap[dto.decision], titleMap[dto.decision], {
      payment_id: paymentId,
      ...(payment.plan_code && { plan_code: payment.plan_code, quantity: payment.quantity }),
      ...(minted > 0 && { subscriptions_minted: minted }),
      ...(dto.rejectionReason && { rejection_reason: dto.rejectionReason }),
    });

    return { message: `Payment ${dto.decision}.`, minted };
  }

  // ================================================================
  // FLAGS
  // ================================================================

  async listOpenFlags(dto: PaginationDto) {
    const { page = 1, limit = 30 } = dto;
    const offset = (page - 1) * limit;

    const query = this.db('flags as f')
      .join('users as reporter', 'reporter.id', 'f.flagged_by')
      .where('f.status', 'open')
      .select(
        'f.id',
        'f.target_type',
        'f.target_id',
        'f.reason',
        'f.status',
        'f.created_at',
        'reporter.id as reporter_id',
        'reporter.email as reporter_email',
        'reporter.account_code as reporter_account_code',
      )
      .orderBy('f.created_at', 'asc');

    const [countRow, rows] = await Promise.all([
      query.clone().clearSelect().clearOrder().count('f.id as total').first(),
      query.limit(limit).offset(offset),
    ]);
    const total = aggregateValue(countRow, 'total');

    return {
      data: rows,
      meta: { total: Number(total), page, limit, pages: Math.ceil(Number(total) / limit) },
    };
  }

  async resolveFlag(adminId: string, flagId: string, dto: ResolveFlagDto) {
    const flag = await this.db('flags').where({ id: flagId }).first();
    if (!flag) throw new NotFoundException('Flag not found.');
    if (flag.status !== 'open') {
      throw new BadRequestException(`Flag has already been ${flag.status}.`);
    }

    await this.db('flags').where({ id: flagId }).update({
      status:        dto.decision,
      resolved_by:   adminId,
      resolved_at:   this.db.fn.now(),
      resolver_note: dto.resolverNote ?? null,
    });

    const auditAction =
      dto.decision === 'dismissed' ? 'flag.dismissed' : 'flag.actioned';

    await this.writeAudit(adminId, auditAction, flag.target_id, dto.resolverNote, {
      flag_id: flagId,
    });

    // Always close the loop with whoever filed the report.
    await this.notify(flag.reporter_id, 'flag_resolved', 'Your report has been reviewed', {
      note: dto.resolverNote,
    });

    // Only notify the flagged party if something was actually done —
    // a dismissal shouldn't alert someone that an unsubstantiated
    // complaint about them existed at all.
    if (dto.decision === 'actioned') {
      const targetUserId = await this.resolveFlagTargetUserId(flag);
      if (targetUserId) {
        await this.notify(targetUserId, 'flag_actioned', 'Action was taken following a report', {
          note: dto.resolverNote,
        });
      }
    }

    return { message: `Flag ${dto.decision}.` };
  }

  // flags.target_id is polymorphic — a user id for profile flags, a
  // message id for message flags, a conversation id for conversation
  // flags (see the flag_target enum). Resolves it to the user who
  // should be notified when action is taken.
  private async resolveFlagTargetUserId(flag: {
    target_type: string;
    target_id: string;
    reporter_id: string;
  }): Promise<string | null> {
    if (flag.target_type === 'profile') {
      return flag.target_id;
    }
    if (flag.target_type === 'message') {
      const message = await this.db('messages').where({ id: flag.target_id }).select('sender_id').first();
      return message?.sender_id ?? null;
    }
    if (flag.target_type === 'conversation') {
      const conversation = await this.db('conversations')
        .where({ id: flag.target_id })
        .select('artist_id', 'planner_id')
        .first();
      if (!conversation) return null;
      // Notify whichever participant isn't the reporter.
      return conversation.artist_id === flag.reporter_id ? conversation.planner_id : conversation.artist_id;
    }
    return null;
  }

  // ================================================================
  // AUDIT LOG
  // ================================================================

  async getAuditLog(dto: AuditLogDto) {
    const { page = 1, limit = 30 } = dto;
    const offset = (page - 1) * limit;

    let query = this.db('audit_log as al')
      .join('users as admin_user', 'admin_user.id', 'al.admin_id')
      .select(
        'al.id',
        'al.action',
        'al.target_id',
        'al.note',
        'al.metadata',
        'al.created_at',
        'admin_user.email as admin_email',
        'admin_user.account_code as admin_account_code',
      )
      .orderBy('al.created_at', 'desc');

    if (dto.adminId)  query = query.where('al.admin_id', dto.adminId);
    if (dto.targetId) query = query.where('al.target_id', dto.targetId);
    if (dto.action)   query = query.where('al.action', dto.action);

    const [countRow, rows] = await Promise.all([
      query.clone().clearSelect().clearOrder().count('al.id as total').first(),
      query.limit(limit).offset(offset),
    ]);
    const total = aggregateValue(countRow, 'total');

    return {
      data: rows,
      meta: { total: Number(total), page, limit, pages: Math.ceil(Number(total) / limit) },
    };
  }

  // ================================================================
  // DASHBOARD STATS  (single-query summary for the admin home screen)
  // ================================================================

  async getStats() {
    const [
      users,
      pendingDocs,
      pendingPayments,
      openFlags,
    ] = await Promise.all([
      this.db('users')
        .select('role', 'status')
        .count('id as count')
        .groupBy('role', 'status'),

      this.db('id_documents').where({ status: 'pending' }).count('id as count').first(),
      this.db('payments').where({ status: 'pending' }).count('id as count').first(),
      this.db('flags').where({ status: 'open' }).count('id as count').first(),
    ]);

    return {
      users,
      pendingIdDocuments: aggregateValue(pendingDocs, 'count'),
      pendingPayments:    aggregateValue(pendingPayments, 'count'),
      openFlags:          aggregateValue(openFlags, 'count'),
    };
  }

  // ================================================================
  // ANALYTICS
  //
  // Deliberately limited to what's actually derivable from existing
  // columns — signup timestamps and profile location fields already
  // exist, so these are real. Page views and conversion rate are NOT
  // here: nothing in the schema logs a page view or a funnel step, so
  // there's no honest way to compute them without adding real tracking
  // instrumentation first.
  // ================================================================

  // Daily signup counts for the last `days` days, split by role —
  // powers a real version of the mockup's artist/planner trend.
  async getSignupTrend(days: number) {
    const rows = await this.db('users')
      .where('created_at', '>=', this.db.raw(`CURRENT_DATE - INTERVAL '${days} days'`))
      .whereIn('role', ['artist', 'planner'])
      .select(
        this.db.raw(`DATE(created_at) AS date`),
        'role',
        this.db.raw(`COUNT(*) AS count`),
      )
      .groupByRaw('DATE(created_at), role')
      .orderBy('date', 'asc');

    // Fill in every date in the range with 0s so the frontend doesn't
    // have to guess at gaps — a day with no signups is real information.
    const byDate = new Map<string, { artists: number; planners: number }>();
    for (const row of rows) {
      const dateKey = new Date(row.date).toISOString().slice(0, 10);
      const entry = byDate.get(dateKey) ?? { artists: 0, planners: 0 };
      if (row.role === 'artist') entry.artists = Number(row.count);
      else entry.planners = Number(row.count);
      byDate.set(dateKey, entry);
    }

    const result: { date: string; artists: number; planners: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateKey = d.toISOString().slice(0, 10);
      result.push({ date: dateKey, ...(byDate.get(dateKey) ?? { artists: 0, planners: 0 }) });
    }
    return result;
  }

  // Profile count by city, combining both roles — a real substitute for
  // the mockup's fictional "sign-ups by region" map.
  // Which artist categories are actually getting booked, and which kinds of
  // booker are doing the booking. Both count CONFIRMED bookings only —
  // accepted plus completed. A declined or cancelled booking is not a
  // booking, and a pending one is not one yet.
  //
  // Caveat worth knowing when reading the numbers: an artist can hold
  // several categories, so one booking of a DJ who is also tagged Singer
  // counts toward both. The column answers "how many bookings involved this
  // category", which means the totals will not sum to the booking count.
  private static readonly CONFIRMED_BOOKING_STATUSES = ['accepted', 'completed'];

  async getTopBookedCategories(limit = 5) {
    const rows = await this.db('bookings as b')
      .join('artist_profiles as ap', 'ap.user_id', 'b.artist_id')
      .join('artist_categories as ac', 'ac.artist_profile_id', 'ap.id')
      .join('categories as c', 'c.id', 'ac.category_id')
      .whereIn('b.status', AdminService.CONFIRMED_BOOKING_STATUSES)
      .select('c.name as category')
      .count('* as count')
      .groupBy('c.name')
      .orderBy([{ column: 'count', order: 'desc' }, { column: 'c.name', order: 'asc' }])
      .limit(limit);

    return rows.map((r) => ({ category: r.category, count: Number(r.count) }));
  }

  async getTopBookerTypes(limit = 3) {
    const rows = await this.db('bookings as b')
      .join('planner_profiles as pp', 'pp.user_id', 'b.planner_id')
      .whereIn('b.status', AdminService.CONFIRMED_BOOKING_STATUSES)
      // booker_type is an enum, so it needs a cast before COALESCE can fall
      // back to a plain string for profiles that never set one.
      .select(this.db.raw(`COALESCE(pp.booker_type::text, 'Unspecified') AS booker_type`))
      .count('* as count')
      .groupByRaw(`COALESCE(pp.booker_type::text, 'Unspecified')`)
      .orderBy([{ column: 'count', order: 'desc' }, { column: 'booker_type', order: 'asc' }])
      .limit(limit);

    return rows.map((r) => ({ bookerType: r.booker_type, count: Number(r.count) }));
  }

  async getGeographyBreakdown() {
    const artistCities = this.db('artist_profiles')
      .whereNotNull('location_city')
      .select('location_city as city');
    const plannerCities = this.db('planner_profiles')
      .whereNotNull('location_city')
      .select('location_city as city');

    const rows = await this.db
      .select('city')
      .count('* as count')
      .from(artistCities.unionAll(plannerCities).as('cities'))
      .groupBy('city')
      .orderBy('count', 'desc')
      .limit(10);

    return rows.map((r) => ({ city: r.city, count: Number(r.count) }));
  }

  // ================================================================
  // REVIEWS (moderation)
  // ================================================================

  async listReviews(dto: PaginationDto) {
    const { page = 1, limit = 30 } = dto;
    const offset = (page - 1) * limit;

    const query = this.db('reviews as r')
      .join('users as reviewer', 'reviewer.id', 'r.reviewer_id')
      .join('users as reviewee', 'reviewee.id', 'r.reviewee_id')
      .join('bookings as b',    'b.id', 'r.booking_id')
      .select(
        'r.id',
        'r.overall_score',
        'r.body',
        'r.is_visible',
        'r.reviewer_role',
        'r.submitted_at',
        'reviewer.email as reviewer_email',
        'reviewee.email as reviewee_email',
        'b.event_name',
        'b.event_date',
      )
      .orderBy('r.submitted_at', 'desc');

    const [countRow, rows] = await Promise.all([
      query.clone().clearSelect().clearOrder().count('r.id as total').first(),
      query.limit(limit).offset(offset),
    ]);
    const total = aggregateValue(countRow, 'total');

    return {
      data: rows,
      meta: { total: Number(total), page, limit, pages: Math.ceil(Number(total) / limit) },
    };
  }

  async removeReview(adminId: string, reviewId: string, reviewsService: any) {
    const result = await reviewsService.adminRemove(reviewId);
    await this.writeAudit(adminId, 'review.removed', reviewId, undefined, { review_id: reviewId });
    return result;
  }

  // ================================================================
  // CATEGORIES
  // ================================================================

  async listCategoriesAdmin() {
    // Includes how many artist profiles use each category (via the
    // join table) — needed so the admin UI can warn before a delete.
    return this.db('categories as c')
      .join('category_groups as g', 'g.id', 'c.group_id')
      .leftJoin('artist_categories as ac', 'ac.category_id', 'c.id')
      .groupBy('c.id', 'g.name', 'g.slug', 'g.sort_order')
      .orderBy('g.sort_order', 'asc')
      .orderBy('c.sort_order', 'asc')
      .select(
        'c.id',
        'c.name',
        'c.slug',
        'c.sort_order',
        'c.group_id',
        'g.name as group_name',
        'g.slug as group_slug',
        'c.created_at',
        this.db.raw('COUNT(ac.artist_profile_id)::int AS artist_count'),
      );
  }

  async createCategory(adminId: string, dto: CreateCategoryDto) {
    const group = await this.db('category_groups').where({ id: dto.groupId }).first();
    if (!group) throw new NotFoundException('Category group not found.');

    const slug = dto.slug ?? this.slugify(dto.name);

    const existing = await this.db('categories')
      .where({ slug })
      .orWhere({ name: dto.name })
      .first();
    if (existing) {
      throw new BadRequestException('A category with that name or slug already exists.');
    }

    const [category] = await this.db('categories')
      .insert({ name: dto.name, slug, sort_order: dto.sortOrder ?? 0, group_id: dto.groupId })
      .returning('*');

    await this.writeAudit(adminId, 'category.created', category.id, undefined, {
      name: category.name,
      slug: category.slug,
      group_id: category.group_id,
    });

    return category;
  }

  async updateCategory(adminId: string, categoryId: string, dto: UpdateCategoryDto) {
    const category = await this.db('categories').where({ id: categoryId }).first();
    if (!category) throw new NotFoundException('Category not found.');

    if (dto.groupId) {
      const group = await this.db('category_groups').where({ id: dto.groupId }).first();
      if (!group) throw new NotFoundException('Category group not found.');
    }

    const nextName = dto.name ?? category.name;
    const nextSlug = dto.slug ?? (dto.name ? this.slugify(dto.name) : category.slug);

    if (nextSlug !== category.slug || nextName !== category.name) {
      const clash = await this.db('categories')
        .where({ slug: nextSlug })
        .orWhere({ name: nextName })
        .whereNot({ id: categoryId })
        .first();
      if (clash) {
        throw new BadRequestException('A category with that name or slug already exists.');
      }
    }

    const [updated] = await this.db('categories')
      .where({ id: categoryId })
      .update({
        name:       nextName,
        slug:       nextSlug,
        sort_order: dto.sortOrder ?? category.sort_order,
        group_id:   dto.groupId ?? category.group_id,
      })
      .returning('*');

    await this.writeAudit(adminId, 'category.updated', categoryId, undefined, {
      before: { name: category.name, slug: category.slug, sort_order: category.sort_order, group_id: category.group_id },
      after:  { name: updated.name, slug: updated.slug, sort_order: updated.sort_order, group_id: updated.group_id },
    });

    return updated;
  }

  async deleteCategory(adminId: string, categoryId: string) {
    const category = await this.db('categories').where({ id: categoryId }).first();
    if (!category) throw new NotFoundException('Category not found.');

    const countRow = await this.db('artist_categories')
      .where({ category_id: categoryId })
      .count('artist_profile_id as count')
      .first();
    const count = aggregateValue(countRow, 'count');

    if (count > 0) {
      throw new BadRequestException(
        `Cannot delete — ${count} artist profile(s) still use this category. Reassign them first.`,
      );
    }

    await this.db('categories').where({ id: categoryId }).del();

    await this.writeAudit(adminId, 'category.deleted', categoryId, undefined, {
      name: category.name,
      slug: category.slug,
    });

    return { message: 'Category deleted.' };
  }

  // ================================================================
  // CATEGORY GROUPS
  // ================================================================

  async listCategoryGroups() {
    return this.db('category_groups as g')
      .leftJoin('categories as c', 'c.group_id', 'g.id')
      .groupBy('g.id')
      .orderBy('g.sort_order', 'asc')
      .select(
        'g.id',
        'g.name',
        'g.slug',
        'g.icon',
        'g.sort_order',
        'g.created_at',
        this.db.raw('COUNT(c.id)::int AS category_count'),
      );
  }

  async createCategoryGroup(adminId: string, dto: CreateCategoryGroupDto) {
    const slug = dto.slug ?? this.slugify(dto.name);

    const existing = await this.db('category_groups')
      .where({ slug })
      .orWhere({ name: dto.name })
      .first();
    if (existing) {
      throw new BadRequestException('A category group with that name or slug already exists.');
    }

    const [group] = await this.db('category_groups')
      .insert({ name: dto.name, slug, icon: dto.icon ?? null, sort_order: dto.sortOrder ?? 0 })
      .returning('*');

    await this.writeAudit(adminId, 'category_group.created', group.id, undefined, {
      name: group.name,
      slug: group.slug,
    });

    return group;
  }

  async updateCategoryGroup(adminId: string, groupId: string, dto: UpdateCategoryGroupDto) {
    const group = await this.db('category_groups').where({ id: groupId }).first();
    if (!group) throw new NotFoundException('Category group not found.');

    const nextName = dto.name ?? group.name;
    const nextSlug = dto.slug ?? (dto.name ? this.slugify(dto.name) : group.slug);

    if (nextSlug !== group.slug || nextName !== group.name) {
      const clash = await this.db('category_groups')
        .where({ slug: nextSlug })
        .orWhere({ name: nextName })
        .whereNot({ id: groupId })
        .first();
      if (clash) {
        throw new BadRequestException('A category group with that name or slug already exists.');
      }
    }

    const [updated] = await this.db('category_groups')
      .where({ id: groupId })
      .update({
        name:       nextName,
        slug:       nextSlug,
        icon:       dto.icon ?? group.icon,
        sort_order: dto.sortOrder ?? group.sort_order,
      })
      .returning('*');

    await this.writeAudit(adminId, 'category_group.updated', groupId, undefined, {
      before: { name: group.name, slug: group.slug },
      after:  { name: updated.name, slug: updated.slug },
    });

    return updated;
  }

  async deleteCategoryGroup(adminId: string, groupId: string) {
    const group = await this.db('category_groups').where({ id: groupId }).first();
    if (!group) throw new NotFoundException('Category group not found.');

    const countRow = await this.db('categories')
      .where({ group_id: groupId })
      .count('id as count')
      .first();
    const count = aggregateValue(countRow, 'count');

    if (count > 0) {
      throw new BadRequestException(
        `Cannot delete — ${count} categor${Number(count) === 1 ? 'y' : 'ies'} still belong to this group. Reassign or delete them first.`,
      );
    }

    await this.db('category_groups').where({ id: groupId }).del();

    await this.writeAudit(adminId, 'category_group.deleted', groupId, undefined, {
      name: group.name,
      slug: group.slug,
    });

    return { message: 'Category group deleted.' };
  }

  // Simple slugify — lowercase, strip non-alphanumerics, hyphen-join.
  // No external dependency; matches the ^[a-z0-9]+(-[a-z0-9]+)*$ pattern
  // enforced by the DTO validators.
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  // ================================================================
  // Internal helpers
  // ================================================================

  private async writeAudit(
    adminId:  string,
    action:   string,
    targetId: string,
    note?:    string,
    metadata: Record<string, any> = {},
  ) {
    await this.db('audit_log').insert({
      admin_id:  adminId,
      action,
      target_id: targetId,
      note:      note ?? null,
      metadata:  JSON.stringify(metadata),
    });
  }

  // Mirrors bookings.service.ts's private notify() — writes a user-facing
  // row to `notifications`, distinct from the admin-only `audit_log` above.
  private async notify(
    userId: string,
    type:   string,
    title:  string,
    data:   Record<string, any> = {},
  ) {
    await this.db('notifications').insert({
      user_id: userId,
      type,
      title,
      data: JSON.stringify(data),
    });
  }
}
