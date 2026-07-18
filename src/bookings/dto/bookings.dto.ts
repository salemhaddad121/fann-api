import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// ----------------------------------------------------------------
// Planner creates a booking proposal
// ----------------------------------------------------------------
export class CreateBookingDto {
  @IsUUID()
  artistId: string;

  @IsOptional()
  @IsUUID()
  conversationId?: string;  // link to the thread this came from

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  eventName: string;

  @IsDateString()
  eventDate: string;  // ISO date "2025-09-14"

  @IsOptional()
  @IsString()
  @MaxLength(300)
  eventLocation?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(24)
  durationHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  agreedFeeUsd?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// ----------------------------------------------------------------
// Artist accepts or declines a booking
// ----------------------------------------------------------------
export class RespondBookingDto {
  @IsIn(['accepted', 'declined'])
  decision: 'accepted' | 'declined';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ----------------------------------------------------------------
// Either party cancels an accepted booking
// ----------------------------------------------------------------
export class CancelBookingDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
