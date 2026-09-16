import { ValidationPipe } from '@nestjs/common';
import { SearchArtistsDto, UpdateArtistProfileDto } from './artists.dto';

// The same pipe configuration app.module.ts registers globally. Validating
// against a hand-rolled validator would prove nothing about what the running
// API does — forbidNonWhitelisted in particular is what makes the social
// link key set a fixed set rather than a suggestion.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const search = (value: unknown) =>
  pipe.transform(value, { type: 'query', metatype: SearchArtistsDto });

const update = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: UpdateArtistProfileDto });

async function rejects(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
  } catch (err: any) {
    return err.getStatus();
  }
  throw new Error('expected the DTO to reject this value, but it was accepted');
}

describe('SearchArtistsDto', () => {
  // H3 — this used to reach SQL and return 500 "invalid input syntax for
  // type date" on an unauthenticated endpoint.
  it('rejects a malformed availableOn with a 400', async () => {
    expect(await rejects(() => search({ availableOn: 'notadate' }))).toBe(400);
  });

  it('still accepts a real ISO date', async () => {
    await expect(search({ availableOn: '2026-12-31' })).resolves.toMatchObject({
      availableOn: '2026-12-31',
    });
  });
});

describe('UpdateArtistProfileDto', () => {
  // H4 — 1e12 passed @Min(0), overflowed NUMERIC(10,2) and returned 500.
  it('rejects a price beyond the column precision', async () => {
    expect(await rejects(() => update({ basePriceUsd: 1e12 }))).toBe(400);
    expect(await rejects(() => update({ depositUsd: 1e12 }))).toBe(400);
  });

  it('accepts a price the column can hold', async () => {
    await expect(update({ basePriceUsd: 850 })).resolves.toMatchObject({
      basePriceUsd: 850,
    });
  });

  // H6 — 400 entries were accepted and stored, then serialised into every
  // search response that listed the profile.
  it('rejects 400 languages', async () => {
    const languages = Array.from({ length: 400 }, (_, i) => `lang${i}`);
    expect(await rejects(() => update({ languages }))).toBe(400);
  });

  it('rejects a single language longer than the cap', async () => {
    expect(await rejects(() => update({ languages: ['x'.repeat(51)] }))).toBe(400);
  });

  it('accepts a normal language list', async () => {
    await expect(update({ languages: ['Arabic', 'English'] })).resolves.toMatchObject({
      languages: ['Arabic', 'English'],
    });
  });

  // H6 / M7 — a single value of 50,000 characters was accepted.
  it('rejects a 50,000-character social link', async () => {
    expect(
      await rejects(() => update({ socialLinks: { instagram: 'x'.repeat(50000) } })),
    ).toBe(400);
  });

  it('rejects a javascript: URL', async () => {
    expect(
      await rejects(() => update({ socialLinks: { website: 'javascript:alert(1)' } })),
    ).toBe(400);
  });

  it('rejects a social platform outside the fixed key set', async () => {
    expect(
      await rejects(() => update({ socialLinks: { myspace: 'https://myspace.com/x' } })),
    ).toBe(400);
  });

  it('accepts the links a real profile carries, with or without a scheme', async () => {
    await expect(
      update({
        socialLinks: {
          instagram: 'https://instagram.com/karim',
          website: 'karimnassar.com',
        },
      }),
    ).resolves.toMatchObject({
      socialLinks: { instagram: 'https://instagram.com/karim', website: 'karimnassar.com' },
    });
  });

  it('treats an empty link as clearing the field, not as an invalid URL', async () => {
    const result: any = await update({ socialLinks: { instagram: '' } });
    expect(result.socialLinks.instagram).toBeUndefined();
  });

  // H11 step 4 — @IsOptional() skipped null as well as undefined, so this
  // passed validation and then violated the column's NOT NULL constraint.
  it('rejects an explicitly null displayName', async () => {
    expect(await rejects(() => update({ displayName: null }))).toBe(400);
  });

  it('still accepts an omitted displayName', async () => {
    await expect(update({ bio: 'Oud player.' })).resolves.toMatchObject({
      bio: 'Oud player.',
    });
  });

  it('rejects explicitly null languages and socialLinks', async () => {
    expect(await rejects(() => update({ languages: null }))).toBe(400);
    expect(await rejects(() => update({ socialLinks: null }))).toBe(400);
  });
});
