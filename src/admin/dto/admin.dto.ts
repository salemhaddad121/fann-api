import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole, UserStatus } from '../../users/users.types';

// ----------------------------------------------------------------
// Shared pagination base — every admin list endpoint extends this
// ----------------------------------------------------------------
export class PaginationDto {
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
  limit?: number = 30;
}

// ----------------------------------------------------------------
// Users
// ----------------------------------------------------------------
export class ListUsersDto extends PaginationDto {
  @IsOptional()
  @IsIn(['artist', 'planner', 'admin'])
  role?: UserRole;

  // 'deleted' is not a real users.status value — soft-deleted accounts keep
  // their old status and set deleted_at. It's accepted here as a filter so
  // the admin list can offer the same five states it displays.
  @IsOptional()
  @IsIn(['pending_review', 'active', 'suspended', 'banned', 'deleted'])
  status?: UserStatus | 'deleted';

  @IsOptional()
  @IsString()
  q?: string;
}

export class ResetUserPasswordDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdateUserStatusDto {
  @IsIn(['active', 'suspended', 'banned'])
  status: 'active' | 'suspended' | 'banned';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ----------------------------------------------------------------
// ID documents
// ----------------------------------------------------------------
export class ReviewIdDocumentDto {
  @IsIn(['approved', 'rejected'])
  decision: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectionReason?: string;
}

// ----------------------------------------------------------------
// Payments (manual confirmation — no payment processor involved;
// membership is paid via a 3rd-party app and the admin confirms
// the transfer manually against the reference code)
// ----------------------------------------------------------------
export class ReviewPaymentDto {
  @IsIn(['confirmed', 'rejected'])
  decision: 'confirmed' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  rejectionReason?: string;
}

// ----------------------------------------------------------------
// Flags
// ----------------------------------------------------------------
export class ResolveFlagDto {
  @IsIn(['dismissed', 'actioned'])
  decision: 'dismissed' | 'actioned';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  resolverNote?: string;
}

// ----------------------------------------------------------------
// Audit log
// ----------------------------------------------------------------
export class AuditLogDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  adminId?: string;

  @IsOptional()
  @IsUUID()
  targetId?: string;

  @IsOptional()
  @IsString()
  action?: string;
}

// ----------------------------------------------------------------
// Categories
// ----------------------------------------------------------------
export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsUUID()
  groupId: string;

  // Optional — auto-generated from `name` (slugified) if omitted.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase, alphanumeric, and hyphen-separated (e.g. "live-band")',
  })
  slug?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number = 0;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase, alphanumeric, and hyphen-separated (e.g. "live-band")',
  })
  slug?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

// ----------------------------------------------------------------
// Category groups
// ----------------------------------------------------------------
export class CreateCategoryGroupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase, alphanumeric, and hyphen-separated (e.g. "performance-entertainment")',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string; // e.g. "ti-music" — Tabler Icons class used in the mockups

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number = 0;
}

export class UpdateCategoryGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase, alphanumeric, and hyphen-separated (e.g. "performance-entertainment")',
  })
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
