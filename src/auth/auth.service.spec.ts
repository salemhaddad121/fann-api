import * as bcrypt from 'bcrypt';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService, EMAIL_NOT_VERIFIED } from './auth.service';
import { UserRecord } from '../users/users.types';

jest.mock('bcrypt');

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    email: 'current@example.com',
    phone: null,
    passwordHash: 'hashed',
    role: 'planner',
    status: 'active',
    accountCode: 'PLN-001',
    emailVerifiedAt: new Date(),
    phoneVerifiedAt: null,
    createdAt: new Date(),
    deletedAt: null,
    pendingEmail: null,
    ...overrides,
  };
}

function makeService() {
  const usersService = {
    create: jest.fn(),
    findById: jest.fn(),
    findByEmail: jest.fn(),
    findByOAuth: jest.fn(),
    linkOAuthAccount: jest.fn(),
    updateLastLogin: jest.fn(),
    updatePhone: jest.fn(),
    markPhoneVerified: jest.fn(),
    setPendingEmail: jest.fn(),
    applyPendingEmail: jest.fn(),
    markEmailVerified: jest.fn(),
  };
  const jwtService = { sign: jest.fn(() => 'signed.jwt.token') };
  const redisService = {
    getEmailVerifyToken: jest.fn(),
    setEmailVerifyToken: jest.fn(),
    deleteEmailVerifyToken: jest.fn(),
    getOtp: jest.fn(),
    setOtp: jest.fn(),
    deleteOtp: jest.fn(),
    recordOtpFailure: jest.fn(),
    setRefreshToken: jest.fn(),
  };
  const emailService = {
    sendVerificationEmail: jest.fn(),
  };
  const configService = {
    get: jest.fn(() => 'http://localhost:3000'),
  };
  const consentService = {
    record: jest.fn(),
  };
  const verificationService = {
    openForSignup: jest.fn(),
  };

  const service = new AuthService(
    usersService as any,
    jwtService as any,
    redisService as any,
    emailService as any,
    configService as any,
    consentService as any,
    verificationService as any,
  );

  return { service, usersService, redisService, emailService, consentService, verificationService };
}

describe('AuthService', () => {
  describe('register()', () => {
    function registerDto(overrides: Record<string, unknown> = {}) {
      return {
        email: 'new@example.com',
        password: 'Fann@dev2025',
        role: 'planner' as const,
        acceptedTerms: true,
        acceptedPrivacy: true,
        ...overrides,
      };
    }

    function setup() {
      const harness = makeService();
      harness.usersService.create.mockResolvedValue(makeUser({ id: 'new-user' }));
      return harness;
    }

    it('records terms and privacy but not marketing when it was left alone', async () => {
      // Absent must not become a granted=false row either: "declined" and
      // "never asked" are different facts and §24.2 wants a positive act.
      const { service, consentService } = setup();

      await service.register(registerDto() as never);

      expect(consentService.record).toHaveBeenCalledTimes(1);
      expect(consentService.record.mock.calls[0][1]).toEqual(['terms', 'privacy']);
    });

    it('adds marketing to the same insert when it was ticked', async () => {
      // One insert, not two — a signup must not be able to half-record
      // consent.
      const { service, consentService } = setup();

      await service.register(registerDto({ acceptedMarketing: true }) as never);

      expect(consentService.record).toHaveBeenCalledTimes(1);
      expect(consentService.record.mock.calls[0][1]).toEqual([
        'terms',
        'privacy',
        'marketing',
      ]);
    });

    it('leaves marketing out when it was explicitly refused', async () => {
      const { service, consentService } = setup();

      await service.register(registerDto({ acceptedMarketing: false }) as never);

      expect(consentService.record.mock.calls[0][1]).toEqual(['terms', 'privacy']);
    });

    it('snapshots the address from the form, not the created account', async () => {
      // makeUser() returns current@example.com; the form said new@example.com.
      // §3.4 wants the contact as at acceptance, and the account's address
      // can change afterwards.
      const { service, consentService } = setup();

      await service.register(registerDto() as never);

      expect(consentService.record.mock.calls[0][2]).toMatchObject({
        contactEmail: 'new@example.com',
      });
    });
  });

  describe('requestEmailChange()', () => {
    it('rejects an incorrect current password', async () => {
      const { service, usersService } = makeService();
      usersService.findById.mockResolvedValueOnce(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);

      await expect(
        service.requestEmailChange('user-1', 'new@example.com', 'wrong-password'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a "change" to the same email already in use', async () => {
      const { service, usersService } = makeService();
      usersService.findById.mockResolvedValueOnce(makeUser({ email: 'same@example.com' }));

      await expect(
        service.requestEmailChange('user-1', 'SAME@example.com', 'irrelevant'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an email already used by another account', async () => {
      const { service, usersService } = makeService();
      usersService.findById.mockResolvedValueOnce(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
      usersService.findByEmail.mockResolvedValueOnce(makeUser({ id: 'someone-else' }));

      await expect(
        service.requestEmailChange('user-1', 'taken@example.com', 'correct-password'),
      ).rejects.toThrow(ConflictException);
    });

    it('sends the verification email to the NEW address, not the current one', async () => {
      const { service, usersService, emailService } = makeService();
      const user = makeUser({ email: 'current@example.com' });
      usersService.findById.mockResolvedValueOnce(user);
      (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
      usersService.findByEmail.mockResolvedValueOnce(null);

      await service.requestEmailChange('user-1', 'new@example.com', 'correct-password');

      expect(usersService.setPendingEmail).toHaveBeenCalledWith('user-1', 'new@example.com');
      expect(emailService.sendVerificationEmail).toHaveBeenCalledWith(
        'new@example.com',
        expect.any(String),
      );
    });
  });

  describe('verifyEmail()', () => {
    it('rejects an invalid or expired token', async () => {
      const { service, redisService } = makeService();
      redisService.getEmailVerifyToken.mockResolvedValueOnce(null);

      await expect(service.verifyEmail('bad-token')).rejects.toThrow(BadRequestException);
    });

    it('promotes the pending email instead of just marking the current one verified, when a change is pending', async () => {
      const { service, usersService, redisService } = makeService();
      redisService.getEmailVerifyToken.mockResolvedValueOnce('user-1');
      usersService.findById.mockResolvedValueOnce(
        makeUser({ email: 'current@example.com', pendingEmail: 'new@example.com' }),
      );

      const result = await service.verifyEmail('good-token');

      expect(usersService.applyPendingEmail).toHaveBeenCalledWith('user-1', 'new@example.com');
      expect(usersService.markEmailVerified).not.toHaveBeenCalled();
      expect(result.message).toMatch(/updated/i);
    });

    it('falls back to the original mark-verified behavior when no change is pending', async () => {
      const { service, usersService, redisService } = makeService();
      redisService.getEmailVerifyToken.mockResolvedValueOnce('user-1');
      usersService.findById.mockResolvedValueOnce(makeUser({ pendingEmail: null }));

      const result = await service.verifyEmail('good-token');

      expect(usersService.markEmailVerified).toHaveBeenCalledWith('user-1');
      expect(usersService.applyPendingEmail).not.toHaveBeenCalled();
      expect(result.message).toMatch(/verified successfully/i);
    });
  });

  // ----------------------------------------------------------------
  // H8 — the OAuth path skipped consent, the verification record and the
  // profile row, and linked to any account matching the email.
  // ----------------------------------------------------------------
  describe('findOrCreateOAuthUser()', () => {
    function oauthData(overrides: Record<string, unknown> = {}) {
      return {
        provider: 'google',
        providerUid: 'google-uid-1',
        email: 'social@example.com',
        role: 'planner' as const,
        ...overrides,
      };
    }

    function setup() {
      const harness = makeService();
      harness.usersService.findByOAuth.mockResolvedValue(null);
      harness.usersService.findByEmail.mockResolvedValue(null);
      harness.usersService.create.mockResolvedValue(makeUser({ id: 'oauth-user' }));
      return harness;
    }

    it('records terms and privacy for a new social sign-up', async () => {
      // Anyone who signed up with Google or Apple previously had no row in
      // user_consents at all — no versioned acceptance of either document.
      const { service, consentService } = setup();

      await service.findOrCreateOAuthUser(oauthData() as never);

      expect(consentService.record).toHaveBeenCalledTimes(1);
      expect(consentService.record.mock.calls[0][1]).toEqual(['terms', 'privacy']);
    });

    it('does not record marketing consent — there is no checkbox to tick', async () => {
      const { service, consentService } = setup();

      await service.findOrCreateOAuthUser(oauthData() as never);

      expect(consentService.record.mock.calls[0][1]).not.toContain('marketing');
    });

    it('opens the verification record, as the email path does', async () => {
      const { service, verificationService } = setup();

      await service.findOrCreateOAuthUser(oauthData() as never);

      expect(verificationService.openForSignup).toHaveBeenCalledWith('oauth-user', {});
    });

    it('snapshots the request context onto the consent rows', async () => {
      const { service, consentService } = setup();
      const context = { ipAddress: '1.2.3.4', userAgent: 'Safari' };

      await service.findOrCreateOAuthUser(oauthData() as never, context);

      expect(consentService.record.mock.calls[0][2]).toEqual({
        ...context,
        contactEmail: 'social@example.com',
      });
    });

    it('refuses to link to an existing account that never verified its email', async () => {
      // The takeover chain: an attacker registers victim@gmail.com with a
      // password and never verifies. The real owner signs in with Google and
      // used to be dropped straight into the attacker's account.
      const { service, usersService } = setup();
      usersService.findByEmail.mockResolvedValue(
        makeUser({ id: 'attacker', emailVerifiedAt: null }),
      );

      await expect(
        service.findOrCreateOAuthUser(oauthData() as never),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(usersService.linkOAuthAccount).not.toHaveBeenCalled();
    });

    it('still links to an existing account that HAS verified its email', async () => {
      const { service, usersService } = setup();
      usersService.findByEmail.mockResolvedValue(
        makeUser({ id: 'real-owner', emailVerifiedAt: new Date() }),
      );

      const user = await service.findOrCreateOAuthUser(oauthData() as never);

      expect(user.id).toBe('real-owner');
      expect(usersService.linkOAuthAccount).toHaveBeenCalledWith(
        'real-owner',
        'google',
        'google-uid-1',
      );
    });

    it('returns an already-linked account without touching consent', async () => {
      const { service, usersService, consentService } = setup();
      usersService.findByOAuth.mockResolvedValue(makeUser({ id: 'returning' }));

      const user = await service.findOrCreateOAuthUser(oauthData() as never);

      expect(user.id).toBe('returning');
      expect(consentService.record).not.toHaveBeenCalled();
      expect(usersService.create).not.toHaveBeenCalled();
    });

    // `state` is a query parameter anyone can write, and UserRole includes
    // 'admin'. Unchecked, GET /auth/google?state=admin created an admin.
    it('refuses to mint an admin from the OAuth state parameter', async () => {
      const { service, usersService } = setup();

      await service.findOrCreateOAuthUser(oauthData({ role: 'admin' }) as never);

      expect(usersService.create.mock.calls[0][0].role).toBe('artist');
    });

    it('honours a legitimate planner role', async () => {
      const { service, usersService } = setup();

      await service.findOrCreateOAuthUser(oauthData({ role: 'planner' }) as never);

      expect(usersService.create.mock.calls[0][0].role).toBe('planner');
    });
  });

  // ----------------------------------------------------------------
  // H9 — registration promised "open it to activate your account", and
  // then both audit accounts logged in having opened nothing.
  // ----------------------------------------------------------------
  describe('login()', () => {
    it('refuses an account whose email has never been verified', async () => {
      const { service } = makeService();

      await expect(
        service.login(makeUser({ emailVerifiedAt: null })),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('carries a distinct code so the client can offer a resend', async () => {
      // 'wrong password' and 'not verified yet' need different screens, and
      // a client cannot tell them apart by matching on prose.
      const { service } = makeService();

      await service.login(makeUser({ emailVerifiedAt: null })).catch((err) => {
        expect(err.getResponse()).toMatchObject({ code: EMAIL_NOT_VERIFIED });
      });
      expect.hasAssertions();
    });

    it('lets a verified account through', async () => {
      const { service } = makeService();
      const user = makeUser({ emailVerifiedAt: new Date() });

      await expect(service.login(user)).resolves.toMatchObject({
        user: expect.objectContaining({ id: user.id }),
      });
    });

    it('still refuses a banned account before it looks at verification', async () => {
      const { service } = makeService();
      await expect(
        service.login(makeUser({ status: 'banned', emailVerifiedAt: null })),
      ).rejects.toThrow('Account banned.');
    });
  });

  describe('resendEmailVerification()', () => {
    it('sends when the address exists and is unverified', async () => {
      const { service, usersService, emailService } = makeService();
      usersService.findByEmail.mockResolvedValue(makeUser({ emailVerifiedAt: null }));

      await service.resendEmailVerification('someone@example.com');

      expect(emailService.sendVerificationEmail).toHaveBeenCalled();
    });

    it.each([
      ['an unknown address', null],
      ['an already-verified account', makeUser({ emailVerifiedAt: new Date() })],
      ['a deleted account', makeUser({ emailVerifiedAt: null, deletedAt: new Date() })],
    ])('sends nothing for %s', async (_label, found) => {
      const { service, usersService, emailService } = makeService();
      usersService.findByEmail.mockResolvedValue(found);

      await service.resendEmailVerification('someone@example.com');

      expect(emailService.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it('answers identically either way, so it cannot be used to enumerate accounts', async () => {
      const { service, usersService } = makeService();

      usersService.findByEmail.mockResolvedValue(null);
      const unknown = await service.resendEmailVerification('nobody@example.com');
      usersService.findByEmail.mockResolvedValue(makeUser({ emailVerifiedAt: null }));
      const known = await service.resendEmailVerification('real@example.com');

      expect(unknown).toEqual(known);
    });
  });

  // ----------------------------------------------------------------
  // B4 / M3 — the code was brute-forceable and the phone was saved
  // before it was ever proved.
  // ----------------------------------------------------------------
  describe('OTP', () => {
    it('does not write the phone number when the code is only sent', async () => {
      // An unverified number used to sit on the account whether or not a
      // code was ever entered.
      const { service, usersService } = makeService();

      await service.sendOtp('user-1', '96170123456').catch(() => undefined);

      expect(usersService.updatePhone).not.toHaveBeenCalled();
    });

    it('writes the phone number only once the code checks out', async () => {
      const { service, usersService, redisService } = makeService();
      redisService.getOtp.mockResolvedValue('123456');

      await service.verifyOtp('user-1', '96170123456', '123456');

      expect(usersService.updatePhone).toHaveBeenCalledWith('user-1', '96170123456');
      expect(usersService.markPhoneVerified).toHaveBeenCalledWith('user-1');
    });

    it('counts a wrong code against the phone number', async () => {
      const { service, redisService } = makeService();
      redisService.getOtp.mockResolvedValue('123456');
      redisService.recordOtpFailure.mockResolvedValue(1);

      await expect(service.verifyOtp('user-1', '96170123456', '000000')).rejects.toThrow(
        'Incorrect OTP.',
      );
      expect(redisService.recordOtpFailure).toHaveBeenCalledWith('96170123456');
    });

    it('destroys the code once the attempt budget is spent', async () => {
      // Per number, not per IP — the throttler limits by address, and an
      // attacker with a few of those gets a few budgets against one target.
      const { service, redisService } = makeService();
      redisService.getOtp.mockResolvedValue('123456');
      redisService.recordOtpFailure.mockResolvedValue(5);

      await expect(service.verifyOtp('user-1', '96170123456', '000000')).rejects.toThrow(
        'Too many incorrect codes. Please request a new one.',
      );
      expect(redisService.deleteOtp).toHaveBeenCalledWith('96170123456');
    });

    it('does not count a failure when the code has simply expired', async () => {
      const { service, redisService } = makeService();
      redisService.getOtp.mockResolvedValue(null);

      await expect(service.verifyOtp('user-1', '96170123456', '123456')).rejects.toThrow(
        'OTP has expired. Please request a new one.',
      );
      expect(redisService.recordOtpFailure).not.toHaveBeenCalled();
    });
  });
});
