import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { aggregateValue } from '../common/db.util';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfirmMediaDto, PresignMediaDto } from './dto/media.dto';

// DB caps mirrored from the CHECK constraint in the schema
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;        // 10 MB
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;       // 250 MB
const MAX_VIDEO_SECONDS = 60;

/** Soft cap on media items per profile. Enforced under a per-user lock. */
const MAX_MEDIA_ITEMS = 20;

const MIME_MAP: Record<string, string> = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
};

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly cdnBase: string;

  constructor(
    @InjectConnection() private readonly db: Knex,
    private readonly configService: ConfigService,
  ) {
    // Optional custom endpoint + path-style addressing so the same client
    // works against any S3-compatible provider (e.g. Cloudflare R2, MinIO)
    // as well as AWS S3. Leave S3_ENDPOINT unset to use AWS's default
    // endpoint; the presign flow below is unchanged either way.
    const endpoint = configService.get<string>('S3_ENDPOINT');
    const forcePathStyle =
      configService.get<string>('S3_FORCE_PATH_STYLE') === 'true';

    this.s3 = new S3Client({
      region:      configService.getOrThrow<string>('AWS_REGION'),
      credentials: {
        accessKeyId:     configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: configService.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
      },
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle,
    });
    this.bucket  = configService.getOrThrow<string>('S3_BUCKET');
    this.cdnBase = configService.getOrThrow<string>('CDN_BASE_URL');
  }

  // ----------------------------------------------------------------
  // Step 1 — generate a presigned PUT URL
  // The client uploads directly to S3; we never touch the bytes.
  // ----------------------------------------------------------------
  async presign(userId: string, dto: PresignMediaDto) {
    this.validateFileSizeCap(dto.mediaType, dto.fileSizeBytes);
    if (dto.mediaType === 'video') {
      if (dto.durationSec == null) {
        throw new BadRequestException('Video duration is required.');
      }
      if (dto.durationSec > MAX_VIDEO_SECONDS) {
        throw new BadRequestException(`Videos must be ${MAX_VIDEO_SECONDS} seconds or shorter.`);
      }
    }

    const ext         = path.extname(dto.filename).toLowerCase();
    const contentType = MIME_MAP[ext];
    if (!contentType) {
      throw new BadRequestException(`Unsupported file type: ${ext}`);
    }

    const s3Key = `uploads/${userId}/${crypto.randomUUID()}${ext}`;

    const command = new PutObjectCommand({
      Bucket:        this.bucket,
      Key:           s3Key,
      ContentType:   contentType,
      ContentLength: dto.fileSizeBytes,
    });

    const presignedUrl = await getSignedUrl(this.s3, command, { expiresIn: 300 }); // 5 min

    return { presignedUrl, s3Key };
  }

  // ----------------------------------------------------------------
  // Step 2 — confirm upload, write DB row
  // ----------------------------------------------------------------
  async confirm(userId: string, dto: ConfirmMediaDto) {
    this.validateFileSizeCap(dto.mediaType, dto.fileSizeBytes);

    // The key comes from the client and is written straight into the row,
    // so it is checked rather than trusted — the same guard
    // IdentityDocumentsService.confirm() already applies to its own prefix.
    //
    // Without it the key is not merely guessable, it is published:
    // cdn_url is `${CDN_BASE_URL}/${s3_key}`, so anyone who can see a photo
    // on a public profile can read that photo's exact key straight back out
    // of the URL. Confirming it creates a row they own pointing at someone
    // else's object, which then passes the ownership check in remove() —
    // and remove() deletes the object from the bucket. That is any
    // logged-in user being able to delete any artist's photos, and to
    // display them as their own in the meantime.
    if (!dto.s3Key.startsWith(`uploads/${userId}/`)) {
      throw new BadRequestException('That upload does not belong to you.');
    }

    // The ownership prefix above says the key is in the caller's namespace.
    // It does not say an object is actually there — and nothing else asked
    // S3 either, so a row could be written, and artist_profiles.thumbnail_url
    // set, for a key that was never uploaded. The result is a broken image on
    // a public profile and a blank thumbnail in search, with a database that
    // believes everything is fine.
    await this.assertObjectExists(dto.s3Key, dto.fileSizeBytes);

    const cdnUrl = `${this.cdnBase}/${dto.s3Key}`;

    // Everything below is a read-then-write over this user's media, and all
    // three values it derives are wrong under concurrency:
    //
    //   * the 20-item cap — two uploads confirming in parallel at 19 both
    //     see 19, both pass, and 21 land
    //   * sort_order      — both read the same max and both append at the
    //     same position
    //   * is_primary      — two first uploads both see count 0 and both
    //     become primary, which the thumbnail sync then settles by
    //     whichever wrote last
    //
    // A transaction alone fixes none of them: under READ COMMITTED the
    // second transaction's count simply does not see the first's
    // uncommitted row. The advisory lock is what serialises them. It is
    // transaction-scoped, so it is released on commit or rollback with no
    // cleanup path to forget, and it is keyed on the user, so two artists
    // uploading at the same moment never wait on each other.
    return this.db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`media:${userId}`]);

      const countRow = await trx('media')
        .where({ user_id: userId })
        .count('id as count')
        .first();
      const count = aggregateValue(countRow, 'count');

      if (count >= MAX_MEDIA_ITEMS) {
        throw new BadRequestException(
          `Maximum of ${MAX_MEDIA_ITEMS} media items per profile.`,
        );
      }

      // Determine sort_order — append to end
      const maxSortRow = await trx('media')
        .where({ user_id: userId })
        .max('sort_order as maxSort')
        .first();
      const maxSort = maxSortRow?.maxSort ?? null;

      const sortOrder = maxSort !== null ? Number(maxSort) + 1 : 0;

      // First photo becomes primary automatically
      const isPrimary = count === 0 && dto.mediaType === 'photo';

      const [row] = await trx('media')
        .insert({
          user_id:         userId,
          media_type:      dto.mediaType,
          s3_key:          dto.s3Key,
          cdn_url:         cdnUrl,
          file_size_bytes: dto.fileSizeBytes,
          duration_sec:    dto.durationSec ?? null,
          is_primary:      isPrimary,
          sort_order:      sortOrder,
        })
        .returning('*');

      // Keep the profile thumbnail in sync if this is now primary. Inside
      // the transaction, so a profile never points at a media row that
      // rolled back.
      if (isPrimary) {
        await this.syncThumbnail(userId, cdnUrl, trx);
      }

      return row;
    });
  }

  /**
   * Asks S3 whether the object is really there, and whether it is the size
   * the client said it was.
   *
   * The size check earns its place as much as the existence one:
   * file_size_bytes is client-supplied and is what the cap logic and
   * profile completeness read, so a 40 MB video declared as 1 KB would
   * otherwise be taken on the client's word. The presigned PUT pins
   * ContentLength, so a mismatch means what landed is not what was declared.
   */
  private async assertObjectExists(s3Key: string, declaredBytes: number): Promise<void> {
    let head;
    try {
      head = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key }),
      );
    } catch (err: any) {
      const status = err?.$metadata?.httpStatusCode;
      if (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') {
        throw new BadRequestException(
          'That upload was not found in storage. Please upload the file again.',
        );
      }
      // A 403, a timeout or an outage is not the caller's fault and must
      // not be reported as though they sent something wrong.
      this.logger.error(`[Media] HeadObject failed for ${s3Key}: ${err?.message ?? err}`);
      throw err;
    }

    if (head.ContentLength !== undefined && head.ContentLength !== declaredBytes) {
      throw new BadRequestException(
        'The uploaded file does not match the size that was declared.',
      );
    }
  }

  // ----------------------------------------------------------------
  // Set a media item as primary
  // ----------------------------------------------------------------
  async setPrimary(userId: string, mediaId: string) {
    const item = await this.db('media').where({ id: mediaId }).first();
    if (!item)                  throw new NotFoundException('Media item not found.');
    if (item.user_id !== userId) throw new ForbiddenException('Not your media.');
    if (item.media_type !== 'photo') {
      throw new BadRequestException('Only photos can be set as primary.');
    }

    // Unset current primary, set new one — in a transaction
    await this.db.transaction(async (trx) => {
      await trx('media').where({ user_id: userId, is_primary: true }).update({ is_primary: false });
      await trx('media').where({ id: mediaId }).update({ is_primary: true });
    });

    await this.syncThumbnail(userId, item.cdn_url);
    return { message: 'Primary photo updated.' };
  }

  // ----------------------------------------------------------------
  // Delete a media item
  // ----------------------------------------------------------------
  async remove(userId: string, mediaId: string) {
    const item = await this.db('media').where({ id: mediaId }).first();
    if (!item)                   throw new NotFoundException('Media item not found.');
    if (item.user_id !== userId)  throw new ForbiddenException('Not your media.');

    // Row first, object second, and the object's failure is survivable.
    //
    // It was the other way round with no error handling, so any storage
    // error — a timeout, a 403, R2 having a bad minute — threw before the
    // row was touched. The user pressed delete, got a 500, and the photo
    // was still on their profile; retrying hit the same wall.
    //
    // This way the user-visible effect always happens. The cost is an
    // orphaned object while storage is down, which is invisible and costs
    // storage — strictly better than a photo its owner cannot remove. The
    // key is logged at error level so it can be swept.
    await this.db('media').where({ id: mediaId }).delete();

    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: item.s3_key }));
    } catch (err: any) {
      this.logger.error(
        `[Media] Row ${mediaId} deleted but its object was not. ` +
        `Orphaned key: ${item.s3_key} — ${err?.message ?? err}`,
      );
    }

    // If deleted item was primary, promote the next photo
    if (item.is_primary) {
      const nextPhoto = await this.db('media')
        .where({ user_id: userId, media_type: 'photo' })
        .orderBy('sort_order', 'asc')
        .first();

      if (nextPhoto) {
        await this.db('media').where({ id: nextPhoto.id }).update({ is_primary: true });
        await this.syncThumbnail(userId, nextPhoto.cdn_url);
      } else {
        await this.syncThumbnail(userId, null);
      }
    }

    return { message: 'Media deleted.' };
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------
  private validateFileSizeCap(mediaType: 'photo' | 'video', bytes: number) {
    if (mediaType === 'photo' && bytes > MAX_PHOTO_BYTES) {
      throw new BadRequestException('Photos must be 10 MB or smaller.');
    }
    if (mediaType === 'video' && bytes > MAX_VIDEO_BYTES) {
      throw new BadRequestException('Videos must be 250 MB or smaller.');
    }
  }

  private async syncThumbnail(
    userId: string,
    cdnUrl: string | null,
    trx: Knex | Knex.Transaction = this.db,
  ) {
    // Update whichever profile table this user belongs to
    await trx('artist_profiles')
      .where({ user_id: userId })
      .update({ thumbnail_url: cdnUrl });
    await trx('planner_profiles')
      .where({ user_id: userId })
      .update({ thumbnail_url: cdnUrl });
  }
}
