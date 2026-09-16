import {
  IsIn,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  IsOptional,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

// ----------------------------------------------------------------
// Start a conversation
//
// A planner sends artistId; an artist sends plannerId. Both are optional
// at the DTO level because which one is required depends on the caller's
// role — the service rejects the wrong pairing with a clear message.
// ----------------------------------------------------------------
export class CreateConversationDto {
  @IsOptional()
  @IsUUID()
  artistId?: string; // the artist's user UUID — sent by planners

  @IsOptional()
  @IsUUID()
  plannerId?: string; // the planner's user UUID — sent by artists
}

// ----------------------------------------------------------------
// Planner accepts or declines an artist's message request
// ----------------------------------------------------------------
export class RespondToRequestDto {
  @IsIn(['accepted', 'declined'])
  decision: 'accepted' | 'declined';
}

// ----------------------------------------------------------------
// Send a message
// ----------------------------------------------------------------
export class SendMessageDto {
  // Trimmed BEFORE validation, not after.
  //
  // @IsNotEmpty() only rejects the empty string, and a body of three
  // spaces is not the empty string — so it passed, returned 201, and put a
  // blank bubble in the conversation. Trimming in the service instead
  // would be too late: the validator has already approved by then, and the
  // 4,000-character cap would be measured against padding.
  //
  // The trimmed value is what gets stored, so leading and trailing
  // whitespace never reaches the database either.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty({ message: 'Message cannot be empty.' })
  @MaxLength(4000)
  body: string;
}

// ----------------------------------------------------------------
// Paginate messages
// ----------------------------------------------------------------
export class GetMessagesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;
}
