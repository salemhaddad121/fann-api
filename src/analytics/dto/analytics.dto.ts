import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// A single page view the client finished measuring.
export class PageEventDto {
  // Normalised route only — '/artists/[id]', never '/artists/<uuid>'.
  // Enforced here as well as client-side so a crafted request cannot fill
  // the table with unbounded distinct values or real ids.
  @IsString()
  @MaxLength(120)
  @Matches(/^\/[A-Za-z0-9\-_/[\]().]*$/, {
    message: 'path must be a normalised route with no query string',
  })
  path: string;

  // Foreground milliseconds. Capped at 6 hours: anything longer is a stuck
  // timer or a forged payload, not a person reading a page.
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6 * 60 * 60 * 1000)
  durationMs: number;

  @IsISO8601()
  occurredAt: string;
}

export class RecordPageEventsDto {
  // Batched, so a browsing session is a handful of requests rather than one
  // per navigation — which also keeps this under the global throttler.
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PageEventDto)
  events: PageEventDto[];

  // Client-generated, held in sessionStorage, so it dies with the tab and
  // is never a cookie. It is what makes a session duration computable for
  // a visitor with no account — without it a guest's page views are
  // unlinkable and only countable.
  //
  // Optional so a client running older JS keeps reporting rather than
  // having its whole batch rejected; those rows simply have no session.
  @IsOptional()
  @IsUUID()
  sessionId?: string;
}

// A search that was actually executed. Recorded server-side from the search
// handler, never posted by the client — a client-reported search count is
// trivially inflated, and these numbers are meant to drive decisions about
// which categories to recruit for.
export class RecordSearchDto {
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  queryText?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  resultCount?: number;
}
