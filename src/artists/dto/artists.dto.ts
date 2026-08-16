import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsISO4217CurrencyCode,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../../common/pagination.constants';

// ----------------------------------------------------------------
// Search / list query
// ----------------------------------------------------------------
export class SearchArtistsDto {
  @IsOptional()
  @IsString()
  q?: string; // full-text search across display_name and bio

  // Accepts either repeated params (?categories=dj&categories=mc-host)
  // or a comma-separated string (?categories=dj,mc-host).
  // Matches ANY artist who has at least one of these categories.
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value
      : String(value).split(',').map((s) => s.trim()).filter(Boolean),
  )
  @IsArray()
  @IsString({ each: true })
  categories?: string[]; // category slugs

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  verifiedOnly?: boolean;

  // availability: only artists free on this date (ISO date string)
  @IsOptional()
  @IsString()
  availableOn?: string;

  @IsOptional()
  @IsIn(['price_asc', 'price_desc', 'newest'])
  sort?: 'price_asc' | 'price_desc' | 'newest';

  // Capped, not just floored. An unbounded page number turns into an
  // unbounded OFFSET, which Postgres will happily scan through.
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

// ----------------------------------------------------------------
// Update own profile
// ----------------------------------------------------------------
export class UpdateArtistProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  // Full replace — send the complete set of category IDs the artist
  // wants (1 to 4). Omit the field entirely to leave categories unchanged.
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(4)
  @IsUUID(undefined, { each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  locationCity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  locationCountry?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  basePriceUsd?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];

  @IsOptional()
  @IsObject()
  socialLinks?: Record<string, string>;

  // Numeric, not free text: a deposit has to be comparable and summable,
  // and "half up front" cannot be either. NULL and 0 both mean "none
  // required" — the column allows either and the UI treats them the same.
  @IsOptional()
  @IsNumber()
  @Min(0)
  depositUsd?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  cancellationPolicy?: string;
}
