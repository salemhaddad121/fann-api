import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateAvailabilityBlockDto {
  @IsDateString()
  startDate: string; // ISO date: "2025-07-01"

  @IsDateString()
  endDate: string;   // ISO date: "2025-07-05"

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
