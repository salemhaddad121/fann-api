import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
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

@Injectable()
export class AdminService {
  constructor(@InjectConnection() private readonly db: Knex) {}

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

    if (dto.role)   query = query.where('u.role', dto.role);
    if (dto.status) query = query.where('u.status', dto.status);
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

    await this.db('users').where({ id: userId }).update({ status: dto.status });

    // Map status change → audit action
    const actionMap = {
      active:    'user.approved',
      suspended: 'user.suspended',
      banned:    'user.banned',
    } as const;

    await this.writeAudit(adminId, actionMap[dto.status], userId, dto.note);

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
        'doc.uploaded_at',
        'u.email',
        'u.role',
        'u.account_code',
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

      // Approving the doc → flip is_verified on the artist profile
      if (dto.decision === 'approved') {
        await trx('artist_profiles')
          .where({ user_id: doc.user_id })
          .update({ is_verified: true });
      }
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
      .where('p.status', 'pending')
      .select(
        'p.id',
        'p.planner_id',
        'p.amount_usd',
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
    if (payment.status !== 'pending') {
      throw new BadRequestException(`Payment has already been ${payment.status}.`);
    }
    if (dto.decision === 'rejected' && !dto.rejectionReason) {
      throw new BadRequestException('A rejection reason is required.');
    }

    await this.db('payments').where({ id: paymentId }).update({
      status:           dto.decision,
      rejection_reason: dto.rejectionReason ?? null,
      confirmed_by:     dto.decision === 'confirmed' ? adminId : null,
      confirmed_at:     dto.decision === 'confirmed' ? this.db.fn.now() : null,
    });

    const auditAction =
      dto.decision === 'confirmed' ? 'payment.confirmed' : 'payment.rejected';

    await this.writeAudit(adminId, auditAction, payment.planner_id, dto.rejectionReason, {
      payment_id:       paymentId,
      transfer_service: payment.transfer_service,
      reference:        payment.reference_code,
      ...(dto.rejectionReason && { rejection_reason: dto.rejectionReason }),
    });

    const titleMap = {
      confirmed: 'Your payment was confirmed',
      rejected:  'Your payment was rejected',
    } as const;
    const typeMap = { confirmed: 'payment_confirmed', rejected: 'payment_rejected' } as const;
    await this.notify(payment.planner_id, typeMap[dto.decision], titleMap[dto.decision], {
      payment_id: paymentId,
      ...(dto.rejectionReason && { rejection_reason: dto.rejectionReason }),
    });

    return { message: `Payment ${dto.decision}.` };
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
      .groupBy(this.db.raw('DATE(created_at)'), 'role')
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
      .groupBy('c.id', 'g.name', 'g.slug')
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
