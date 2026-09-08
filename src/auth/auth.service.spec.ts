import * as bcrypt from 'bcrypt';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AuthService } from './auth.service';
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
    setPendingEmail: jest.fn(),
    applyPendingEmail: jest.fn(),
    markEmailVerified: jest.fn(),
  };
  const jwtService = {};
  const redisService = {
    getEmailVerifyToken: jest.fn(),
    setEmailVerifyToken: jest.fn(),
    deleteEmailVerifyToken: jest.fn(),
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
});
