import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../../common/pagination.constants';
import { SocialLinksDto } from '../../common/social-links.dto';

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
  // @ValidateIf, not @IsOptional — the latter skips null as well as
  // undefined, so an explicit `"displayName": null` reached a NOT NULL
  // column as a 500. Mirrors UpdateArtistProfileDto.
  @ValidateIf((_, value) => value !== undefined)
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

  // Bounded, and not nullable — same reasoning as the artist DTO's
  // `languages`.
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  eventTypes?: string[];

  @ValidateIf((_, value) => value !== undefined)
  @ValidateNested()
  @Type(() => SocialLinksDto)
  socialLinks?: SocialLinksDto;

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

  // Capped, not just floored — see the artists DTO.
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number = 20;
}
