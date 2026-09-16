import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PlanCode } from '../../common/subscription.util';

export const PLAN_CODES = ['day', 'month', 'year'] as const;

/**
 * Upper bound on a single purchase. Day passes are sold in packs, so a
 * quantity above one is normal here — but an unbounded integer means a
 * mistyped amount can mint thousands of credit rows against one payment,
 * and there is no legitimate reason to buy more than a month's worth of
 * day passes in one go.
 */
export const MAX_PURCHASE_QUANTITY = 30;

/**
 * The transfer services a buyer may SELECT today. Whish only.
 *
 * Deliberately narrower than the payment_service enum in migration 001,
 * which still carries 'OMT' and 'WesternUnion'. That enum is not migrated
 * and must not be: historical rows reference those values, and the admin
 * panel's label map should keep rendering them so old payments stay
 * readable. This constant governs what a new purchase may claim, which is
 * a different question from what an old one already says.
 *
 * Note the spelling. 'Wish' is wrong and is known to be wrong — see
 * whish.provider.ts — but it is the enum value with seed data behind it,
 * and both the plans page and the admin panel already map it to "Whish
 * Money" for display. Do not add a second misspelling, and do not fix this
 * one here.
 */
export const TRANSFER_SERVICES = ['Wish', 'other'] as const;

export class CreatePaymentIntentDto {
  @IsIn(PLAN_CODES)
  planCode: PlanCode;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PURCHASE_QUANTITY)
  quantity?: number;

  // Both optional: the intent is created before the buyer has transferred
  // anything, so these arrive later via PATCH once they have a reference
  // to report. Wave 7's automated providers fill neither.
  @IsOptional()
  @IsIn(TRANSFER_SERVICES)
  transferService?: (typeof TRANSFER_SERVICES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceCode?: string;
}

export class ReportTransferDto {
  @IsIn(TRANSFER_SERVICES)
  transferService: (typeof TRANSFER_SERVICES)[number];

  @IsString()
  @MaxLength(100)
  referenceCode: string;
}
