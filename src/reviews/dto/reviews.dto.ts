import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SubmitReviewDto {
  @IsUUID()
  bookingId: string;

  // 1–5 overall score
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  overallScore: number;

  // QC dimensions — all required, forces thoughtful rating
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  scoreCommunication: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  scoreProfessionalism: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  scorePunctuality: number;

  // Artists: "quality of performance" | Planners: "quality of event organisation"
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  scoreQuality: number;

  // Optional free-text body
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;
}
