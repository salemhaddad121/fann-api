import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ChangePasswordDto, RegisterDto, ResetPasswordDto } from './auth.dto';

describe('ChangePasswordDto', () => {
  it('accepts a password with upper, lower, and a digit', async () => {
    const dto = plainToInstance(ChangePasswordDto, {
      currentPassword: 'whatever',
      newPassword: 'Str0ngPass',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it.each([
    ['too short', 'Str0n'],
    ['no uppercase', 'str0ngpass'],
    ['no lowercase', 'STR0NGPASS'],
    ['no digit', 'StrongPass'],
  ])('rejects a password that is %s', async (_label, newPassword) => {
    const dto = plainToInstance(ChangePasswordDto, {
      currentPassword: 'whatever',
      newPassword,
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a missing current password', async () => {
    const dto = plainToInstance(ChangePasswordDto, { newPassword: 'Str0ngPass' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'currentPassword')).toBe(true);
  });
});

describe('RegisterDto', () => {
  it('accepts a valid registration', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: 'artist@example.com',
      password: 'Str0ngPass',
      role: 'artist',
      acceptedTerms: true,
      acceptedPrivacy: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // The checkbox has to be enforced server-side, not only in the browser —
  // otherwise the consent row we store is evidence of nothing.
  it('rejects a registration that omits consent entirely', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: 'artist@example.com',
      password: 'Str0ngPass',
      role: 'artist',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'acceptedTerms')).toBe(true);
    expect(errors.some((e) => e.property === 'acceptedPrivacy')).toBe(true);
  });

  // @IsBoolean would let `false` through; Equals(true) is what makes it
  // mandatory rather than merely present.
  it('rejects consent explicitly declined', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: 'artist@example.com',
      password: 'Str0ngPass',
      role: 'artist',
      acceptedTerms: false,
      acceptedPrivacy: false,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'acceptedTerms')).toBe(true);
    expect(errors.some((e) => e.property === 'acceptedPrivacy')).toBe(true);
  });

  it('rejects accepting only one of the two', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: 'artist@example.com',
      password: 'Str0ngPass',
      role: 'artist',
      acceptedTerms: true,
      acceptedPrivacy: false,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'acceptedTerms')).toBe(false);
    expect(errors.some((e) => e.property === 'acceptedPrivacy')).toBe(true);
  });

  it('rejects an invalid email', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: 'not-an-email',
      password: 'Str0ngPass',
      role: 'artist',
      acceptedTerms: true,
      acceptedPrivacy: true,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('rejects a role outside artist/planner', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: 'someone@example.com',
      password: 'Str0ngPass',
      role: 'admin',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });
});

describe('ResetPasswordDto', () => {
  it('rejects a missing token', async () => {
    const dto = plainToInstance(ResetPasswordDto, { password: 'Str0ngPass' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'token')).toBe(true);
  });
});
