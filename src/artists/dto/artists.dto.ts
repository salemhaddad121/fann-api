import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../../common/pagination.constants';
import { SocialLinksDto } from '../../common/social-links.dto';

// NUMERIC(10,2) — the largest value the column can hold. Without a ceiling
// a price of 1e12 passes @Min(0), reaches Postgres and raises 22003
// ("numeric field overflow") from inside the driver, which is a 500 on what
// is plainly a bad request.
const MAX_NUMERIC_10_2 = 99999999.99;

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
  //
  // @IsDateString, not @IsString: the value is interpolated into a date
  // comparison, so `?availableOn=notadate` used to reach SQL and come back
  // as a 500 ("invalid input syntax for type date") on the busiest public
  // endpoint on the site.
  @IsOptional()
  @IsDateString()
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
  // @ValidateIf rather than @IsOptional, and the difference matters:
  // @IsOptional() skips validation for null as well as undefined, so
  // `{"displayName": null}` passed every check and then violated the
  // column's NOT NULL constraint as a 500. This accepts an absent field and
  // rejects an explicitly null one.
  @ValidateIf((_, value) => value !== undefined)
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
  @Max(MAX_NUMERIC_10_2)
  basePriceUsd?: number;

  // Bounded on both axes. Unbounded it accepted 400 entries and stored all
  // of them — and languages is serialised into every single search result,
  // so one profile's 400 entries are paid for by every response that lists
  // it.
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  languages?: string[];

  // A fixed key set with a URL and a length cap per value — see
  // SocialLinksDto. @IsObject() validated the container and nothing inside
  // it, which is how a single value of 50,000 characters got stored.
  @ValidateIf((_, value) => value !== undefined)
  @ValidateNested()
  @Type(() => SocialLinksDto)
  socialLinks?: SocialLinksDto;

  // Numeric, not free text: a deposit has to be comparable and summable,
  // and "half up front" cannot be either. NULL and 0 both mean "none
  // required" — the column allows either and the UI treats them the same.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_NUMERIC_10_2)
  depositUsd?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  cancellationPolicy?: string;
}
