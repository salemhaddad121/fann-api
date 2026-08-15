import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import * as path from 'path';
import { requireConfig } from '../common/config.util';

export type IdDocumentKind = 'id_document' | 'selfie';

/** Both artefacts an artist must submit. Order matters for the UI. */
export const REQUIRED_KINDS: IdDocumentKind[] = ['id_document', 'selfie'];

/**
 * How long a decided document's FILE is kept before it is deleted from
 * object storage. The row survives permanently either way — see migration
 * 020 for why those are separate.
 *
 * These are policy, not physics, and they are deliberately short. Fann has
 * no regulatory obligation to retain government ID, so the only reason to
 * keep a scan after the decision is a later dispute about that decision,
 * and the window only has to outlast the plausible period for one.
 *
 * Approved documents get longer because the relationship continues and a
 * fraud question can surface months later. Rejected ones get less because
 * there is no relationship to support — the window exists so the artist can
 * still read why they were rejected and re-submit before the file goes.
 */
export const RETENTION_DAYS_APPROVED = 90;
export const RETENTION_DAYS_REJECTED = 30;

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
};

/** Selfies are photos only — a PDF selfie is a scan of something else. */
const SELFIE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Identity documents: the ID and the selfie an artist submits to go live.
 *
 * Deliberately NOT part of MediaService, even though the presign mechanics
 * look similar. Profile media is written to a public prefix and served
 * from the CDN by URL; a passport scan must never be. These go to a
 * separate `identity/` prefix, only ever the S3 key is stored, and the
 * only way to view one is a short-lived presigned GET issued to an admin.
 * Keeping them in the same service as public media is how one eventually
 * ends up with a CDN URL by accident.
 */
@Injectable()
export class IdentityDocumentsService {
  private readonly logger = new Logger(IdentityDocumentsService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    @InjectConnection() private readonly db: Knex,
    private readonly configService: ConfigService,
  ) {
    this.bucket = requireConfig(configService, 'S3_BUCKET');

    const endpoint = configService.get<string>('S3_ENDPOINT');
    this.s3 = new S3Client({
      region: requireConfig(configService, 'AWS_REGION'),
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: requireConfig(configService, 'AWS_ACCESS_KEY_ID'),
        secretAccessKey: requireConfig(configService, 'AWS_SECRET_ACCESS_KEY'),
      },
    });
  }

  /** Step 1 — a presigned PUT the browser uploads straight to. */
  async presign(
    userId: string,
    input: { kind: IdDocumentKind; filename: string; fileSizeBytes: number },
  ) {
    if (input.fileSizeBytes > MAX_BYTES) {
      throw new BadRequestException('Files must be 15MB or smaller.');
    }

    const ext = path.extname(input.filename).toLowerCase();
    const contentType = MIME_MAP[ext];
    if (!contentType) {
      throw new BadRequestException(`Unsupported file type: ${ext || '(none)'}`);
    }
    if (input.kind === 'selfie' && !SELFIE_EXTENSIONS.includes(ext)) {
      throw new BadRequestException('A selfie must be a photo, not a document.');
    }

    // Separate prefix from public uploads/, so bucket policy and lifecycle
    // rules can treat identity documents differently without having to
    // reason about which key belongs to which feature.
    const s3Key = `identity/${userId}/${input.kind}-${crypto.randomUUID()}${ext}`;

    const presignedUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        ContentType: contentType,
        ContentLength: input.fileSizeBytes,
      }),
      { expiresIn: 300 },
    );

    return { presignedUrl, s3Key };
  }

  /**
   * Step 2 — record the upload.
   *
   * Re-submitting replaces the previous file for that kind and resets the
   * row to pending. An artist correcting a blurry photo after a rejection
   * must not need an admin to delete anything first, and leaving the old
   * approval in place would let a rejected document be quietly swapped for
   * an approved one.
   */
  async confirm(userId: string, input: { kind: IdDocumentKind; s3Key: string }) {
    if (!input.s3Key.startsWith(`identity/${userId}/`)) {
      // The key is client-supplied, so it is checked rather than trusted:
      // without this, a caller could point their row at someone else's
      // uploaded document.
      throw new BadRequestException('That upload does not belong to you.');
    }

    const [row] = await this.db('id_documents')
      .insert({
        user_id: userId,
        kind: input.kind,
        s3_key: input.s3Key,
        status: 'pending',
        rejection_reason: null,
        reviewed_by: null,
        reviewed_at: null,
        uploaded_at: this.db.fn.now(),
      })
      .onConflict(['user_id', 'kind'])
      .merge(['s3_key', 'status', 'rejection_reason', 'reviewed_by', 'reviewed_at', 'uploaded_at'])
      .returning(['id', 'kind', 'status', 'uploaded_at']);

    return row;
  }

  /**
   * What the artist sees about their own verification.
   *
   * Returns a row per required kind whether or not it has been uploaded,
   * so the UI can render the full checklist from one call instead of
   * inferring what is missing from what is absent.
   */
  async getMine(userId: string) {
    const rows = await this.db('id_documents')
      .where({ user_id: userId })
      .select('kind', 'status', 'rejection_reason', 'uploaded_at', 'reviewed_at');

    const byKind = new Map(rows.map((r) => [r.kind as IdDocumentKind, r]));

    const documents = REQUIRED_KINDS.map((kind) => {
      const row = byKind.get(kind);
      return {
        kind,
        status: (row?.status as string) ?? 'missing',
        rejection_reason: row?.rejection_reason ?? null,
        uploaded_at: row?.uploaded_at ?? null,
        reviewed_at: row?.reviewed_at ?? null,
      };
    });

    return {
      documents,
      complete: documents.every((d) => d.status === 'approved'),
      // What is actually blocking them, phrased for a person.
      outstanding: documents
        .filter((d) => d.status !== 'approved')
        .map((d) => describeOutstanding(d.kind, d.status)),
    };
  }

  /**
   * A short-lived link for an admin to view one document.
   *
   * Issued per view rather than stored, and never returned to the owner:
   * these are read by a reviewer, not displayed back on a profile.
   */
  async presignViewUrl(documentId: string): Promise<string> {
    const doc = await this.db('id_documents').where({ id: documentId }).first();
    if (!doc) throw new NotFoundException('Document not found.');

    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: doc.s3_key }),
      { expiresIn: 300 },
    );
  }

  /**
   * Deletes identity files whose retention window has passed.
   *
   * Three groups, and the third is the one that matters most:
   *
   *   approved  — file removed RETENTION_DAYS_APPROVED after the decision
   *   rejected  — file removed RETENTION_DAYS_REJECTED after the decision
   *   deleted accounts — removed on the next run, whatever the status
   *
   * The last has no window at all. Someone who has closed their account has
   * withdrawn the reason we held their passport, and "we will get to it in
   * 90 days" is not an answer to that.
   *
   * PENDING documents are never touched. They are the ones still waiting to
   * be looked at, and deleting the file would leave a reviewer with a
   * decision to make and nothing to make it on.
   *
   * Object storage is deleted BEFORE the row is updated. If the delete
   * fails the key stays put and the row is retried on the next run — the
   * opposite order would drop our only pointer to the file and orphan it in
   * the bucket forever, which is exactly the outcome this exists to avoid.
   */
  async pruneExpiredDocuments(): Promise<{
    purged: number;
    failed: number;
  }> {
    const candidates = await this.db('id_documents as d')
      .join('users as u', 'u.id', 'd.user_id')
      .whereNotNull('d.s3_key')
      .where((b) =>
        b
          // Closed accounts: no window.
          .whereNotNull('u.deleted_at')
          .orWhere((b2) =>
            b2
              .where('d.status', 'approved')
              .whereRaw(`d.reviewed_at < now() - interval '${RETENTION_DAYS_APPROVED} days'`),
          )
          .orWhere((b2) =>
            b2
              .where('d.status', 'rejected')
              .whereRaw(`d.reviewed_at < now() - interval '${RETENTION_DAYS_REJECTED} days'`),
          ),
      )
      .select('d.id', 'd.s3_key', 'd.status', 'd.user_id');

    let purged = 0;
    let failed = 0;

    for (const doc of candidates) {
      try {
        await this.s3.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: doc.s3_key }),
        );

        await this.db('id_documents').where({ id: doc.id }).update({
          s3_key: null,
          purged_at: this.db.fn.now(),
        });

        purged++;
      } catch (err) {
        // One unreachable object must not stop the rest of the sweep.
        failed++;
        this.logger.error(
          `[Retention] Failed to purge identity document ${doc.id}`,
          err,
        );
      }
    }

    if (purged > 0 || failed > 0) {
      this.logger.log(
        `[Retention] Purged ${purged} identity document(s), ${failed} failed`,
      );
    }

    return { purged, failed };
  }

  /**
   * Whether a user has both required documents approved.
   *
   * The single source of truth for the activation gate — admin activation
   * calls this rather than reimplementing the count, so the rule cannot
   * drift between the check and what the artist is told.
   */
  async hasCompleteVerification(userId: string): Promise<boolean> {
    const rows = await this.db('id_documents')
      .where({ user_id: userId, status: 'approved' })
      .select('kind');

    const approved = new Set(rows.map((r) => r.kind as IdDocumentKind));
    return REQUIRED_KINDS.every((kind) => approved.has(kind));
  }
}

function describeOutstanding(kind: IdDocumentKind, status: string): string {
  const label = kind === 'selfie' ? 'selfie' : 'ID document';

  if (status === 'missing') return `Upload your ${label}`;
  if (status === 'rejected') return `Your ${label} was rejected — upload a new one`;
  return `Your ${label} is waiting to be reviewed`;
}
