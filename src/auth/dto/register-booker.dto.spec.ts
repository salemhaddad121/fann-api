import { ValidationPipe } from '@nestjs/common';
import { RegisterDto } from './auth.dto';

// The same pipe app.module.ts registers globally — validating against a
// hand-rolled validator would prove nothing about the running API.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const register = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: RegisterDto });

function base(overrides: Record<string, unknown> = {}) {
  return {
    email: 'someone@example.com',
    password: 'Fann@dev2025',
    acceptedTerms: true,
    acceptedPrivacy: true,
    ...overrides,
  };
}

async function rejects(value: unknown): Promise<number> {
  try {
    await register(value);
  } catch (err: any) {
    return err.getStatus();
  }
  throw new Error('expected the DTO to reject this, but it was accepted');
}

describe('RegisterDto — the booker questionnaire (C2)', () => {
  // The artist branch must stay exactly one step. Artists are the supply
  // side and every extra field costs roster.
  it('asks an artist for none of it', async () => {
    await expect(register(base({ role: 'artist' }))).resolves.toMatchObject({
      role: 'artist',
    });
  });

  it('rejects a booker with no kind', async () => {
    expect(await rejects(base({ role: 'planner', interests: ['musical_acts'] }))).toBe(400);
  });

  it('rejects a booker with no interests', async () => {
    expect(await rejects(base({ role: 'planner', plannerKind: 'individual' }))).toBe(400);
  });

  it('rejects an empty interest list', async () => {
    // Minimum one (Q1). An empty array is a client that skipped the step.
    expect(
      await rejects(base({ role: 'planner', plannerKind: 'individual', interests: [] })),
    ).toBe(400);
  });

  it('accepts an individual with one interest', async () => {
    await expect(
      register(base({ role: 'planner', plannerKind: 'individual', interests: ['photo_video'] })),
    ).resolves.toMatchObject({ plannerKind: 'individual', interests: ['photo_video'] });
  });

  it('accepts several interests — a wedding wants a band AND a photographer', async () => {
    await expect(
      register(
        base({
          role: 'planner',
          plannerKind: 'individual',
          interests: ['musical_acts', 'photo_video', 'djs_and_services'],
        }),
      ),
    ).resolves.toMatchObject({ interests: ['musical_acts', 'photo_video', 'djs_and_services'] });
  });

  it('rejects an interest that is not one of the four buckets', async () => {
    expect(
      await rejects(
        base({ role: 'planner', plannerKind: 'individual', interests: ['caterers'] }),
      ),
    ).toBe(400);
  });

  it('requires a bookerType from a company', async () => {
    expect(
      await rejects(base({ role: 'planner', plannerKind: 'company', interests: ['musical_acts'] })),
    ).toBe(400);
  });

  it('does not ask an individual for a bookerType', async () => {
    // An individual has no company type and asking would be nonsense.
    await expect(
      register(base({ role: 'planner', plannerKind: 'individual', interests: ['musical_acts'] })),
    ).resolves.toMatchObject({ plannerKind: 'individual' });
  });

  it('accepts a company with a valid type', async () => {
    await expect(
      register(
        base({
          role: 'planner',
          plannerKind: 'company',
          bookerType: 'Venue',
          interests: ['musical_acts'],
        }),
      ),
    ).resolves.toMatchObject({ bookerType: 'Venue' });
  });

  it('rejects a bookerType outside the enum', async () => {
    expect(
      await rejects(
        base({
          role: 'planner',
          plannerKind: 'company',
          bookerType: 'Nightclub',
          interests: ['musical_acts'],
        }),
      ),
    ).toBe(400);
  });

  // Audit finding H11: @IsOptional() treats an explicit null as absent and
  // lets it through to a NOT NULL column. @ValidateIf does not.
  it('rejects an explicitly null kind rather than treating it as absent', async () => {
    expect(
      await rejects(
        base({ role: 'planner', plannerKind: null, interests: ['musical_acts'] }),
      ),
    ).toBe(400);
  });

  it('still rejects a refused Terms checkbox, booker or not', async () => {
    expect(
      await rejects(
        base({
          role: 'planner',
          plannerKind: 'individual',
          interests: ['musical_acts'],
          acceptedTerms: 'false',
        }),
      ),
    ).toBe(400);
  });
});
