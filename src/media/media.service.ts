import {
  BadRequestException,
  ForbiddenException,
  Injectable,
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
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as path from 'path';
import * as crypto from 'crypto';
import { ConfirmMediaDto, PresignMediaDto } from './dto/media.dto';

// DB caps mirrored from the CHECK constraint in the schema
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;        // 10 MB
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;       // 250 MB
const MAX_VIDEO_SECONDS = 60;

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

    // Check user doesn't already have too many items (soft cap: 20)
    const countRow = await this.db('media')
      .where({ user_id: userId })
      .count('id as count')
      .first();
    const count = aggregateValue(countRow, 'count');

    if (count >= 20) {
      throw new BadRequestException('Maximum of 20 media items per profile.');
    }

    const cdnUrl = `${this.cdnBase}/${dto.s3Key}`;

    // Determine sort_order — append to end
    const maxSortRow = await this.db('media')
      .where({ user_id: userId })
      .max('sort_order as maxSort')
      .first();
    const maxSort = maxSortRow?.maxSort ?? null;

    const sortOrder = maxSort !== null ? Number(maxSort) + 1 : 0;

    // First photo becomes primary automatically
    const isPrimary = count === 0 && dto.mediaType === 'photo';

    const [row] = await this.db('media')
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

    // Keep artist thumbnail_url in sync if this is now primary
    if (isPrimary) {
      await this.syncThumbnail(userId, cdnUrl);
    }

    return row;
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

    // Delete from S3
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: item.s3_key }));

    await this.db('media').where({ id: mediaId }).delete();

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

  private async syncThumbnail(userId: string, cdnUrl: string | null) {
    // Update whichever profile table this user belongs to
    await this.db('artist_profiles')
      .where({ user_id: userId })
      .update({ thumbnail_url: cdnUrl });
    await this.db('planner_profiles')
      .where({ user_id: userId })
      .update({ thumbnail_url: cdnUrl });
  }
}
