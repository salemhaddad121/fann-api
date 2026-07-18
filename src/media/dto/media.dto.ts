import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export type MediaType = 'photo' | 'video';

// Step 1 — request a presigned S3 URL before uploading
export class PresignMediaDto {
  @IsIn(['photo', 'video'])
  mediaType: MediaType;

  // Original filename used to derive the S3 Content-Type
  @IsString()
  @IsNotEmpty()
  filename: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  fileSizeBytes: number;

  // Required for videos; validated against 60-second cap
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(60)
  durationSec?: number;
}

// Step 2 — confirm upload completed, create the DB row
export class ConfirmMediaDto {
  @IsString()
  @IsNotEmpty()
  s3Key: string;

  @IsIn(['photo', 'video'])
  mediaType: MediaType;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  fileSizeBytes: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @Max(60)
  durationSec?: number;
}
