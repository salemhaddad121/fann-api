import { Injectable } from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { ConsentService } from '../consent/consent.service';

export type VerificationResult =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'manually_approved';

export interface AuditStep {
  at: string;
  actor: string;
  step: string;
  detail?: string;
}

@Injectable()
export class VerificationService {
  constructor(
    @InjectConnection() private readonly db: Knex,
    private readonly consentService: ConsentService,
  ) {}

  /**
   * Opens a record when an account is created. Everything a provider would
   * supply is left null — see migration 017 — but the things only we can
   * know (who, when, from where, under which terms) are captured while they
   * are still available.
   *
   * The consent snapshot is copied rather than joined: user_consents is
   * append-only, so a join would later show the current acceptance, not the
   * one in force when this record was opened.
   */
  async openForSignup(
    userId: string,
    context: { ipAddress?: string | null; userAgent?: string | null } = {},
  ): Promise<void> {
    const consents = await this.consentService.listForUser(userId);

    await this.db('verification_records').insert({
      user_id: userId,
      result: 'pending',
      ip_address: context.ipAddress ?? null,
      user_agent: context.userAgent ?? null,
      consent_snapshot: JSON.stringify(
        consents.map((c) => ({
          document: c.document,
          version: c.version,
          accepted_at: c.accepted_at,
          ip_address: c.ip_address,
        })),
      ),
      audit_log: JSON.stringify([
        this.step('system', 'account_created', 'Account registered; awaiting review.'),
      ]),
    });
  }

  /**
   * Settles the open record when an admin approves or rejects an account.
   *
   * 'manually_approved' rather than 'passed': an admin reading an uploaded
   * document is a different assurance from a provider attestation, and the
   * log should not imply checks that were never run.
   */
  async recordAdminDecision(
    userId: string,
    adminId: string,
    approved: boolean,
    note?: string,
  ): Promise<void> {
    const record = await this.latestFor(userId);
    if (!record) return;

    const step = this.step(
      adminId,
      approved ? 'manually_approved' : 'manually_rejected',
      note ?? undefined,
    );

    await this.db('verification_records')
      .where({ id: record.id })
      .update({
        result: approved ? 'manually_approved' : 'failed',
        completed_at: this.db.fn.now(),
        reviewed_by: adminId,
        methods: JSON.stringify(['manual_review']),
        // Append rather than replace — the log is the point.
        audit_log: this.db.raw('audit_log || ?::jsonb', [JSON.stringify([step])]),
      });
  }

  /** Appends a step without changing the result. */
  async appendStep(
    userId: string,
    actor: string,
    stepName: string,
    detail?: string,
  ): Promise<void> {
    const record = await this.latestFor(userId);
    if (!record) return;

    await this.db('verification_records')
      .where({ id: record.id })
      .update({
        audit_log: this.db.raw('audit_log || ?::jsonb', [
          JSON.stringify([this.step(actor, stepName, detail)]),
        ]),
      });
  }

  /** Newest record for a user, or null if none. */
  async latestFor(userId: string) {
    return this.db('verification_records')
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .first();
  }

  /** Full history for one user, newest first. */
  async listForUser(userId: string) {
    return this.db('verification_records')
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .select('*');
  }

  /**
   * The admin log view. Joined to users so the list is readable without a
   * lookup per row, and filterable by result.
   */
  async list(options: { result?: VerificationResult; limit?: number; page?: number } = {}) {
    const limit = Math.min(options.limit ?? 50, 200);
    const page = Math.max(options.page ?? 1, 1);

    const base = this.db('verification_records as vr')
      .join('users as u', 'u.id', 'vr.user_id')
      .modify((q) => {
        if (options.result) q.where('vr.result', options.result);
      });

    const [rows, countRow] = await Promise.all([
      base
        .clone()
        .orderBy('vr.created_at', 'desc')
        .limit(limit)
        .offset((page - 1) * limit)
        .select(
          'vr.*',
          'u.email as user_email',
          'u.role as user_role',
          'u.status as user_status',
          'u.account_code as user_account_code',
        ),
      base.clone().count('vr.id as total').first(),
    ]);

    return {
      data: rows,
      meta: {
        total: Number(countRow?.total ?? 0),
        page,
        limit,
      },
    };
  }

  private step(actor: string, step: string, detail?: string): AuditStep {
    return {
      at: new Date().toISOString(),
      actor,
      step,
      ...(detail ? { detail } : {}),
    };
  }
}
