import {
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
// Start a conversation (planner → artist)
// ----------------------------------------------------------------
export class CreateConversationDto {
  @IsUUID()
  artistId: string; // the artist's user UUID
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
