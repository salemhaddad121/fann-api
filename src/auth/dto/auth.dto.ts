import {
  Equals,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../users/users.types';
import { StrictBoolean } from '../../common/boolean.transform';

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

  // Both are required and must be literally true. @IsBoolean alone would
  // accept `false`, which is the one value that must not get through —
  // Equals(true) is what makes the checkbox mandatory server-side rather
  // than only in the browser.
  //
  // @StrictBoolean is what makes that true in practice. Without it the
  // global pipe's implicit conversion turned the string "false" into `true`
  // before @Equals ever ran, so a request that explicitly refused the Terms
  // created an account AND recorded consent to them. See boolean.transform.ts.
  @StrictBoolean()
  @Equals(true, { message: 'You must accept the Terms of Service to sign up.' })
  acceptedTerms: boolean;

  @StrictBoolean()
  @Equals(true, { message: 'You must accept the Privacy Policy to sign up.' })
  acceptedPrivacy: boolean;

  // Optional, and deliberately NOT @Equals(true). §24.2 requires marketing
  // consent to be separable from accepting the Terms, which means signing
  // up having refused it has to work. Absent reads as false: someone who
  // was never asked has not agreed to anything.
  @IsOptional()
  @StrictBoolean()
  @IsBoolean({ message: 'acceptedMarketing must be true or false.' })
  acceptedMarketing?: boolean;
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

// ----------------------------------------------------------------
// Resend the signup verification email. Unauthenticated by necessity —
// the whole point is that the account cannot be logged into yet.
// ----------------------------------------------------------------
export class ResendVerificationDto {
  @IsEmail({}, { message: 'Enter a valid email address.' })
  email: string;
}
