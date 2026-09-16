import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { UsersService } from '../users/users.service';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../email/email.service';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { RegisterDto } from './dto/auth.dto';
import { UserRecord, UserRole } from '../users/users.types';
import { ConsentService, ConsentContext } from '../consent/consent.service';
import { ConsentDocument } from '../consent/consent.constants';
import { VerificationService } from '../verification/verification.service';

const BCRYPT_ROUNDS = 12;

/**
 * The roles a person may give themselves. 'admin' is granted, never chosen.
 */
const SELF_SERVICE_ROLES: UserRole[] = ['artist', 'planner'];

/**
 * Wrong codes a single phone number may receive before the code is thrown
 * away and a new one has to be requested. Five leaves room for a genuine
 * typo or two and still bounds the search space at a rounding error of the
 * million possible codes.
 */
const MAX_OTP_ATTEMPTS = 5;

/**
 * Error code on the 401 a login gets when the address has not been
 * verified. Exported so the frontend contract has one source, and so a
 * rename cannot silently turn the "resend verification" screen back into a
 * generic "wrong password".
 */
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService:   JwtService,
    private readonly redisService: RedisService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
    private readonly consentService: ConsentService,
    private readonly verificationService: VerificationService,
  ) {}

  // ----------------------------------------------------------------
  // Register
  // ----------------------------------------------------------------
  async register(
    dto: RegisterDto,
    context: ConsentContext = {},
  ): Promise<{ message: string }> {
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.usersService.create({
      email:        dto.email,
      passwordHash,
      role:         dto.role,
      phone:        dto.phone,
    });

    // Recorded before the verification email so a failure to send can't
    // leave an account whose consent went unrecorded. The DTO rejects
    // anything but `true` on terms and privacy, so reaching here means both
    // were accepted.
    //
    // Marketing joins the same insert only when it was actually ticked.
    // Writing a granted=false row for everyone who left it alone would
    // collapse two different facts — "declined" and "never asked" — into
    // one, and §24.2 wants a positive act, not the absence of one.
    const documents: ConsentDocument[] = ['terms', 'privacy'];
    if (dto.acceptedMarketing) documents.push('marketing');

    // The address is snapshotted onto every row (§3.4). dto.email rather
    // than user.email so it is the address they typed on this form, before
    // any later change to the account.
    await this.consentService.record(user.id, documents, {
      ...context,
      contactEmail: dto.email,
    });

    // Opens the verification record while the request context is still
    // available. Consent is recorded first so the snapshot it copies is
    // populated.
    await this.verificationService.openForSignup(user.id, context);

    await this.sendEmailVerification(user);

    return {
      message: 'Account created. Please check your email to verify your address.',
    };
  }

  // ----------------------------------------------------------------
  // Validate local credentials (used by LocalStrategy)
  // ----------------------------------------------------------------
  async validateLocalUser(email: string, password: string): Promise<UserRecord | null> {
    const user = await this.usersService.findByEmail(email);
    if (!user || !user.passwordHash) return null;

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return null;

    return user;
  }

  // ----------------------------------------------------------------
  // Login — called after LocalStrategy has validated credentials
  // ----------------------------------------------------------------
  async login(user: UserRecord): Promise<{
    accessToken: string;
    refreshToken: string;
    user: Partial<UserRecord>;
  }> {
    if (user.deletedAt)               throw new UnauthorizedException('This account has been deleted.');
    if (user.status === 'suspended')  throw new UnauthorizedException('Account suspended.');
    if (user.status === 'banned')     throw new UnauthorizedException('Account banned.');

    // Registration has always ended on "Open it to activate your account,
    // then come back and log in." It was not true: both audit accounts
    // logged in immediately having opened nothing, and every authenticated
    // route worked with emailVerifiedAt still null.
    //
    // Enforcing it is also the second half of H8's takeover chain. An
    // unverified account can no longer be used at all, so registering
    // someone else's address and waiting for them to arrive via Google buys
    // nothing.
    //
    // The distinct `code` is the point of the shape: 'Invalid credentials'
    // and 'not verified yet' need completely different screens, and a
    // client cannot tell them apart by matching on prose.
    if (!user.emailVerifiedAt) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        code: EMAIL_NOT_VERIFIED,
        message: 'Verify your email address before signing in. Check your inbox for the link, or request a new one.',
      });
    }

    await this.usersService.updateLastLogin(user.id);

    const tokens = await this.issueTokens(user);
    return {
      ...tokens,
      user: this.sanitize(user),
    };
  }

  // ----------------------------------------------------------------
  // Refresh access token
  // ----------------------------------------------------------------
  async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token.');
    }

    // Verify the token matches what we stored (prevents reuse after logout)
    const storedHash = await this.redisService.getRefreshToken(payload.sub);
    const incomingHash = this.hashToken(refreshToken);

    if (!storedHash || storedHash !== incomingHash) {
      throw new UnauthorizedException('Refresh token has been invalidated.');
    }

    const user = await this.usersService.findById(payload.sub);
    if (!user) throw new UnauthorizedException('User not found.');

    const accessToken = this.signAccessToken(user);
    return { accessToken };
  }

  // ----------------------------------------------------------------
  // Logout — invalidate refresh token
  // ----------------------------------------------------------------
  async logout(userId: string): Promise<{ message: string }> {
    await this.redisService.deleteRefreshToken(userId);
    return { message: 'Logged out successfully.' };
  }

  // ----------------------------------------------------------------
  // Email verification
  // ----------------------------------------------------------------
  async sendEmailVerification(user: UserRecord): Promise<void> {
    const token = crypto.randomBytes(32).toString('hex');
    await this.redisService.setEmailVerifyToken(token, user.id);

    const url = `${this.configService.get('APP_URL')}/auth/verify-email?token=${token}`;

    await this.emailService.sendVerificationEmail(user.email, url);
  }

  /**
   * Re-sends the signup verification link.
   *
   * Generic response whatever happens, and always the same one — the
   * endpoint is unauthenticated, so a response that varied by whether the
   * address existed, or was already verified, would answer "is this person
   * registered here?" for anyone who asked. Same reasoning as
   * forgotPassword() above, and as the unsubscribe endpoint.
   */
  async resendEmailVerification(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);

    // Nothing to do for an unknown address, an already-verified account, or
    // a deleted one — and in all three cases the caller is told the same
    // thing as a success.
    if (user && !user.emailVerifiedAt && !user.deletedAt) {
      await this.sendEmailVerification(user);
    }

    return {
      message: 'If that address needs verifying, a new link is on its way.',
    };
  }

  async verifyEmail(token: string): Promise<{ message: string }> {
    const userId = await this.redisService.getEmailVerifyToken(token);
    if (!userId) throw new BadRequestException('Verification link is invalid or has expired.');

    const user = await this.usersService.findById(userId);
    if (!user) throw new BadRequestException('Account not found.');

    if (user.pendingEmail) {
      // Confirming an email CHANGE (see requestEmailChange below), not
      // the original signup address — promote the pending address
      // rather than just flipping a verified flag on the current one.
      await this.usersService.applyPendingEmail(userId, user.pendingEmail);
      await this.redisService.deleteEmailVerifyToken(token);
      return { message: 'Email address updated and verified.' };
    }

    await this.usersService.markEmailVerified(userId);
    await this.redisService.deleteEmailVerifyToken(token);

    return { message: 'Email verified successfully.' };
  }

  // Logged-in email change — proves identity via the current password
  // (mirrors changePassword), then re-uses the existing verification-email
  // flow to prove the user actually controls the NEW address before it
  // takes effect. The current email keeps working for login the entire
  // time this is pending; verifyEmail() above completes the swap once the
  // link is clicked.
  async requestEmailChange(
    userId: string,
    newEmail: string,
    currentPassword: string,
  ): Promise<{ message: string }> {
    const user = await this.usersService.findById(userId);
    if (!user) throw new BadRequestException('Account not found.');

    if (user.passwordHash) {
      const match = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!match) throw new BadRequestException('Current password is incorrect.');
    }
    // OAuth-only accounts (no password) skip that check — same reasoning
    // as deleteAccount: nothing to verify against, and they're already
    // authenticated via JWT.

    if (newEmail.toLowerCase() === user.email.toLowerCase()) {
      throw new BadRequestException('That is already your current email address.');
    }

    const existing = await this.usersService.findByEmail(newEmail);
    if (existing) {
      throw new ConflictException('That email is already in use by another account.');
    }

    await this.usersService.setPendingEmail(userId, newEmail);

    // Send the verification link to the NEW address, not the current
    // one — the whole point is proving the user actually controls it.
    await this.sendEmailVerification({ ...user, email: newEmail });

    return {
      message: `Verification email sent to ${newEmail}. Your email won't change until you confirm it.`,
    };
  }

  // ----------------------------------------------------------------
  // Forgot / reset password
  // ----------------------------------------------------------------
  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.usersService.findByEmail(email);

    // Always return the same generic message, and only send an email if
    // a password-based account actually exists — this avoids leaking
    // whether an email is registered or is social-login-only.
    if (user && user.passwordHash) {
      const token = crypto.randomBytes(32).toString('hex');
      await this.redisService.setPasswordResetToken(token, user.id);

      const url = `${this.configService.get('FRONTEND_URL')}/reset-password?token=${token}`;
      await this.emailService.sendPasswordResetEmail(user.email, url);
    }

    return { message: 'If an account with that email exists, a password reset link has been sent.' };
  }

  /**
   * Is this reset link still good?
   *
   * Exists so /reset-password can find out on mount instead of after the
   * user has typed a new password twice and pressed submit. That was the
   * whole of M10: the form rendered for a dead link, and the only way to
   * discover it was dead was to fill it in.
   *
   * Reads the token without consuming it — a check that spent the token
   * would make the page that calls it break the flow it is trying to
   * protect.
   *
   * Not an enumeration risk worth worrying about: the token is 32 random
   * bytes, so "does this one exist" cannot be asked usefully, and the route
   * is throttled. It reveals nothing about any account either way — no
   * address, no id, just whether one specific opaque string is live.
   */
  async isPasswordResetTokenValid(token: string): Promise<{ valid: boolean }> {
    if (!token) return { valid: false };
    const userId = await this.redisService.getPasswordResetToken(token);
    return { valid: Boolean(userId) };
  }

  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    const userId = await this.redisService.getPasswordResetToken(token);
    if (!userId) throw new BadRequestException('Reset link is invalid or has expired.');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.usersService.updatePassword(userId, passwordHash);
    await this.redisService.deletePasswordResetToken(token);

    // Password changed — invalidate any existing session so a stolen
    // refresh token from before the reset stops working.
    await this.redisService.deleteRefreshToken(userId);

    return { message: 'Password reset successfully. Please log in with your new password.' };
  }

  // Logged-in password change — proves identity via the current password
  // rather than an emailed token, so (unlike resetPassword above) the
  // existing session is left alone instead of being invalidated.
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    const user = await this.usersService.findById(userId);
    if (!user) throw new BadRequestException('Account not found.');
    if (!user.passwordHash) {
      throw new BadRequestException('This account signed up with Google/Apple and has no password to change.');
    }

    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) throw new BadRequestException('Current password is incorrect.');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.usersService.updatePassword(userId, passwordHash);

    return { message: 'Password updated.' };
  }

  // Soft-deletes the account (see users.service.ts softDeleteAccount for
  // what that means) after confirming the password. OAuth-only accounts
  // (no password set) skip that check — there's nothing to verify against,
  // and they already proved identity by being logged in via JWT.
  async deleteAccount(userId: string, password: string): Promise<{ message: string }> {
    const user = await this.usersService.findById(userId);
    if (!user) throw new BadRequestException('Account not found.');

    if (user.passwordHash) {
      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match) throw new BadRequestException('Password is incorrect.');
    }

    await this.usersService.softDeleteAccount(userId);
    await this.redisService.deleteRefreshToken(userId);

    return { message: 'Account deleted.' };
  }

  // ----------------------------------------------------------------
  // OTP (phone verification via WhatsApp — Meta Cloud API)
  //
  // Sends the code through a pre-approved WhatsApp "authentication"
  // message template. Meta requires business-initiated messages to
  // use an approved template; free-form text only works within an
  // existing 24h customer-service window, which doesn't apply here.
  // Create/approve the template in Meta Business Manager first —
  // name + language must match WHATSAPP_OTP_TEMPLATE_NAME/_LANG.
  // ----------------------------------------------------------------
  async sendOtp(userId: string, phone: string): Promise<{ message: string }> {
    // The number is NOT written to the account here. It used to be, which
    // meant an unverified number sat on the user whether or not a code was
    // ever entered — type any number, never open WhatsApp, and the account
    // carries it. verifyOtp() writes it, once the code proves the number
    // belongs to whoever is holding the session.

    // crypto.randomInt, not Math.random: Math.random is not a CSPRNG, and
    // its output is predictable from previous draws. A six-digit code is
    // small enough already without also being guessable.
    const code = String(crypto.randomInt(100000, 1000000)); // 6 digits
    await this.redisService.setOtp(phone, code);

    await this.sendWhatsAppOtp(phone, code);

    return { message: 'OTP sent via WhatsApp.' };
  }

  private async sendWhatsAppOtp(phone: string, code: string): Promise<void> {
    const phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const accessToken   = this.configService.get<string>('WHATSAPP_ACCESS_TOKEN');
    const apiVersion     = this.configService.get<string>('WHATSAPP_API_VERSION') ?? 'v20.0';
    const templateName   = this.configService.get<string>('WHATSAPP_OTP_TEMPLATE_NAME') ?? 'otp_verification';
    const templateLang   = this.configService.get<string>('WHATSAPP_OTP_TEMPLATE_LANG') ?? 'en_US';

    // Meta expects the recipient number in international format, digits only
    // (no "+", spaces, or dashes) — e.g. "9613123456" not "+961 3 123 456".
    const to = phone.replace(/[^\d]/g, '');

    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: templateName,
            language: { code: templateLang },
            components: [
              {
                type: 'body',
                parameters: [{ type: 'text', text: code }],
              },
            ],
          },
        }),
      });
    } catch (err) {
      console.error('[WhatsApp] Network error sending OTP:', err);
      throw new InternalServerErrorException('Failed to send OTP. Please try again.');
    }

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[WhatsApp] Failed to send OTP:', response.status, errorBody);
      throw new InternalServerErrorException('Failed to send OTP. Please try again.');
    }
  }

  async verifyOtp(
    userId: string,
    phone: string,
    code: string,
  ): Promise<{ message: string }> {
    const stored = await this.redisService.getOtp(phone);

    if (!stored) throw new BadRequestException('OTP has expired. Please request a new one.');

    if (stored !== code) {
      // Counted per phone number, and the code is destroyed once the budget
      // is spent. The route also carries @Throttle, but that limits by IP,
      // and a six-digit code with a ten-minute life is worth capping on the
      // axis the attacker cannot change. Twenty-five consecutive wrong codes
      // used to all return 400 and none return 429.
      const attempts = await this.redisService.recordOtpFailure(phone);
      if (attempts >= MAX_OTP_ATTEMPTS) {
        await this.redisService.deleteOtp(phone);
        throw new BadRequestException(
          'Too many incorrect codes. Please request a new one.',
        );
      }
      throw new BadRequestException('Incorrect OTP.');
    }

    // Written here rather than in sendOtp(): this is the first moment the
    // number has been shown to belong to the person holding the session.
    await this.usersService.updatePhone(userId, phone);
    await this.usersService.markPhoneVerified(userId);
    await this.redisService.deleteOtp(phone);

    return { message: 'Phone number verified.' };
  }

  // ----------------------------------------------------------------
  // OAuth (Google / Apple) — find-or-create
  // ----------------------------------------------------------------
  async findOrCreateOAuthUser(
    data: {
      provider:    string;
      providerUid: string;
      email:       string;
      role:        UserRole;
    },
    context: ConsentContext = {},
  ): Promise<UserRecord> {
    // 1. Existing OAuth link
    let user = await this.usersService.findByOAuth(data.provider, data.providerUid);
    if (user) return user;

    // 2. Email already registered — link the OAuth account to it, but only
    //    once that account has proved it owns the address.
    //
    //    This branch used to link unconditionally, which is one half of an
    //    account takeover. The other half is that registration does not
    //    require the emailed link to be opened. Together: an attacker
    //    registers victim@gmail.com with a password they choose and never
    //    verifies it; the real owner later signs in with Google, lands here,
    //    and is handed the attacker's account — which the attacker still has
    //    the password to. Neither half is exploitable alone, which is why
    //    both are closed.
    user = await this.usersService.findByEmail(data.email);
    if (user) {
      if (!user.emailVerifiedAt) {
        throw new ConflictException(
          'An unverified account already uses this email address. ' +
          'Verify it from the link we emailed you, then sign in with Google or Apple.',
        );
      }

      await this.usersService.linkOAuthAccount(user.id, data.provider, data.providerUid);
      return user;
    }

    // 3. Brand new user
    //
    //    The role arrives from the OAuth `state` parameter, which is a query
    //    string anybody can write. Constrained to the two roles a person may
    //    sign themselves up as: unchecked, ?state=admin created an admin
    //    account, because UserRole includes 'admin' and nothing between the
    //    query string and the INSERT ever said otherwise.
    const role: UserRole = SELF_SERVICE_ROLES.includes(data.role) ? data.role : 'artist';

    user = await this.usersService.create({
      email:        data.email,
      passwordHash: null, // social-only login
      role,
    });

    await this.usersService.linkOAuthAccount(user.id, data.provider, data.providerUid);

    // Consent and the verification record, exactly as the email path does
    // at register(). Without these a social sign-up had no row in
    // user_consents at all — no versioned acceptance of the Terms or the
    // Privacy Policy for anyone who ever used Google or Apple.
    //
    // This is only honest if the social buttons carry the same "by
    // continuing you accept…" notice the registration form does. That is a
    // Fann---Web change and it is not optional: recording an acceptance
    // nobody was shown would be worse than recording none.
    //
    // Marketing is deliberately absent — it needs a positive act, and there
    // is no checkbox on an OAuth redirect to provide one.
    await this.consentService.record(user.id, ['terms', 'privacy'], {
      ...context,
      contactEmail: data.email,
    });

    await this.verificationService.openForSignup(user.id, context);

    // Social logins get email auto-verified — the provider has already
    // proved the address belongs to whoever is signing in.
    await this.usersService.markEmailVerified(user.id);

    return user;
  }

  async loginOAuthUser(user: UserRecord): Promise<{
    accessToken: string;
    refreshToken: string;
    user: Partial<UserRecord>;
  }> {
    await this.usersService.updateLastLogin(user.id);
    const tokens = await this.issueTokens(user);
    return { ...tokens, user: this.sanitize(user) };
  }

  // ----------------------------------------------------------------
  // Token helpers
  // ----------------------------------------------------------------
  private signAccessToken(user: UserRecord): string {
    const payload: JwtPayload = {
      sub:         user.id,
      email:       user.email,
      role:        user.role,
      status:      user.status,
      accountCode: user.accountCode,
    };
    return this.jwtService.sign(payload, {
      secret:    this.configService.get<string>('JWT_SECRET'),
      expiresIn: '15m',
    });
  }

  private async issueTokens(user: UserRecord): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const accessToken = this.signAccessToken(user);

    const payload: JwtPayload = {
      sub:         user.id,
      email:       user.email,
      role:        user.role,
      status:      user.status,
      accountCode: user.accountCode,
    };
    const refreshToken = this.jwtService.sign(payload, {
      secret:    this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: '30d',
    });

    // Store a hash of the refresh token so we can invalidate it on logout
    await this.redisService.setRefreshToken(user.id, this.hashToken(refreshToken));

    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private sanitize(user: UserRecord): Partial<UserRecord> {
    const { passwordHash, ...safe } = user;
    return safe;
  }
}
