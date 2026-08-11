import { Injectable } from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { CONSENT_VERSIONS, ConsentDocument } from './consent.constants';

export interface ConsentContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ConsentRecord {
  id: string;
  user_id: string;
  document: ConsentDocument;
  version: string;
  accepted_at: Date;
  ip_address: string | null;
  user_agent: string | null;
}

@Injectable()
export class ConsentService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  /**
   * Records acceptance of the given documents at the versions currently
   * live. Written in one insert so a signup can't half-record consent.
   *
   * Takes the documents rather than assuming both, so a later re-acceptance
   * of only a revised privacy notice doesn't rewrite the terms row.
   */
  async record(
    userId: string,
    documents: ConsentDocument[],
    context: ConsentContext = {},
  ): Promise<void> {
    if (documents.length === 0) return;

    await this.db('user_consents').insert(
      documents.map((document) => ({
        user_id: userId,
        document,
        version: CONSENT_VERSIONS[document],
        ip_address: context.ipAddress ?? null,
        user_agent: context.userAgent ?? null,
      })),
    );
  }

  /** Every acceptance for a user, newest first. */
  async listForUser(userId: string): Promise<ConsentRecord[]> {
    return this.db('user_consents')
      .where({ user_id: userId })
      .orderBy('accepted_at', 'desc')
      .select('*');
  }

  /**
   * The latest acceptance of each document, keyed by document. Used by the
   * admin verification view, which cares about current standing rather
   * than the full history.
   */
  async latestForUser(
    userId: string,
  ): Promise<Partial<Record<ConsentDocument, ConsentRecord>>> {
    const rows = await this.listForUser(userId);
    const latest: Partial<Record<ConsentDocument, ConsentRecord>> = {};
    // rows are newest-first, so the first of each document wins.
    for (const row of rows) {
      if (!latest[row.document]) latest[row.document] = row;
    }
    return latest;
  }
}
