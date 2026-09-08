import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import {
  CONSENT_VERSIONS,
  ConsentDocument,
  MANDATORY_DOCUMENTS,
} from './consent.constants';

export interface ConsentContext {
  ipAddress?: string | null;
  userAgent?: string | null;
  /**
   * The address on the account at the time of this consent. Snapshotted
   * rather than joined — see migration 021 — because users.email changes.
   */
  contactEmail?: string | null;
}

export interface ConsentRecord {
  id: string;
  user_id: string;
  document: ConsentDocument;
  version: string;
  accepted_at: Date;
  ip_address: string | null;
  user_agent: string | null;
  granted: boolean;
  contact_email: string | null;
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
        granted: true,
        ip_address: context.ipAddress ?? null,
        user_agent: context.userAgent ?? null,
        contact_email: context.contactEmail ?? null,
      })),
    );
  }

  /**
   * Grants or withdraws an optional consent.
   *
   * Appends a row either way rather than updating the last one. That is the
   * whole design of this table (see 016 and 021): the history is the
   * evidence, and "granted on the 3rd, withdrawn on the 9th" is a different
   * and more useful fact than "currently withdrawn".
   *
   * Refuses the mandatory documents outright. Withdrawing acceptance of the
   * Terms is not a preference — it is closing the account, which has its
   * own flow — and silently accepting a false row here would leave the
   * platform holding a user who is signed in under terms they have on
   * record as having revoked.
   */
  async setConsent(
    userId: string,
    document: ConsentDocument,
    granted: boolean,
    context: ConsentContext = {},
  ): Promise<void> {
    if (MANDATORY_DOCUMENTS.includes(document)) {
      throw new BadRequestException(
        `${document} is a condition of using Fann and cannot be changed here.`,
      );
    }

    await this.db('user_consents').insert({
      user_id: userId,
      document,
      version: CONSENT_VERSIONS[document],
      granted,
      ip_address: context.ipAddress ?? null,
      user_agent: context.userAgent ?? null,
      contact_email: context.contactEmail ?? null,
    });
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

  /**
   * Whether an optional consent currently stands.
   *
   * Absent means false. A user who was never asked has not agreed to
   * anything, and defaulting the other way would turn a missing row into
   * permission to email them.
   */
  async isGranted(userId: string, document: ConsentDocument): Promise<boolean> {
    const latest = await this.db('user_consents')
      .where({ user_id: userId, document })
      .orderBy('accepted_at', 'desc')
      .first();

    return latest?.granted ?? false;
  }
}
