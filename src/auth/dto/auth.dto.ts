import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../users/users.types';

// ----------------------------------------------------------------
// Register
// ----------------------------------------------------------------
export class RegisterDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number.',
  })
  password: string;

  @IsEnum(['artist', 'planner'] as UserRole[], {
    message: 'Role must be either artist or planner.',
  })
  role: Extract<UserRole, 'artist' | 'planner'>;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[1-9]\d{6,14}$/, { message: 'Enter a valid international phone number.' })
  phone?: string;
}

// ----------------------------------------------------------------
// Login
// ----------------------------------------------------------------
export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

// ----------------------------------------------------------------
// Send OTP
// ----------------------------------------------------------------
export class SendOtpDto {
  @IsString()
  @Matches(/^\+?[1-9]\d{6,14}$/, { message: 'Enter a valid international phone number.' })
  phone: string;
}

// ----------------------------------------------------------------
// Verify OTP
// ----------------------------------------------------------------
export class VerifyOtpDto {
  @IsString()
  @Matches(/^\+?[1-9]\d{6,14}$/, { message: 'Enter a valid international phone number.' })
  phone: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'OTP must be a 6-digit number.' })
  code: string;
}

// ----------------------------------------------------------------
// ----------------------------------------------------------------
// Forgot password — request a reset link
// ----------------------------------------------------------------
export class ForgotPasswordDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email: string;
}

// ----------------------------------------------------------------
// Reset password — consume the token from the emailed link
// ----------------------------------------------------------------
export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number.',
  })
  password: string;
}

// ----------------------------------------------------------------
// Change password — while logged in, proving knowledge of the current one
// ----------------------------------------------------------------
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters.' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, and one number.',
  })
  newPassword: string;
}

// ----------------------------------------------------------------
// Change email — while logged in, proving knowledge of the current
// password. Doesn't take effect immediately — see requestEmailChange()
// in auth.service.ts.
// ----------------------------------------------------------------
export class ChangeEmailDto {
  @IsString()
  @IsNotEmpty()
  currentPassword: string;

  @IsEmail({}, { message: 'Enter a valid email address.' })
  newEmail: string;
}

// ----------------------------------------------------------------
// Delete account — soft delete, requires the current password as
// confirmation (same reasoning as changing it: prove it's really you).
// ----------------------------------------------------------------
export class DeleteAccountDto {
  @IsString()
  @IsNotEmpty()
  password: string;
}
