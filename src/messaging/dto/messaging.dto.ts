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
import { Type } from 'class-transformer';

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
  @IsString()
  @IsNotEmpty()
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
