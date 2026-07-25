import {
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

// The fixed set of booker types (Postgres enum `booker_type`). One per booker.
export const BOOKER_TYPES = [
  'Event Planner',
  'Venue',
  'Restaurant',
  'Bar',
  'Wedding Planner',
  'University',
  'Other',
];

export class UpdatePlannerProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  locationCity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  locationCountry?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  eventTypes?: string[];

  @IsOptional()
  @IsObject()
  socialLinks?: Record<string, string>;

  @IsOptional()
  @IsIn(BOOKER_TYPES)
  bookerType?: string;
}

// ----------------------------------------------------------------
// Search / list query — mirrors SearchArtistsDto in
// src/artists/dto/artists.dto.ts, minus the fields planner_profiles
// doesn't have (no price, no is_verified, no categories table link).
// ----------------------------------------------------------------
export class SearchPlannersDto {
  @IsOptional()
  @IsString()
  q?: string; // full-text search across display_name, company_name, and bio

  // Accepts either repeated params (?eventTypes=Wedding&eventTypes=Corporate)
  // or a comma-separated string (?eventTypes=Wedding,Corporate).
  // Matches ANY planner who lists at least one of these event types.
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value
      : String(value).split(',').map((s) => s.trim()).filter(Boolean),
  )
  @IsArray()
  @IsString({ each: true })
  eventTypes?: string[];

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsIn(['newest', 'name_asc'])
  sort?: 'newest' | 'name_asc';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}
