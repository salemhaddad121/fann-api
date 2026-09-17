import { ValidationPipe } from '@nestjs/common';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/admin.dto';

// The same pipe app.module.ts registers globally.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const create = (v: unknown) =>
  pipe.transform(v, { type: 'body', metatype: CreateCategoryDto });
const update = (v: unknown) =>
  pipe.transform(v, { type: 'body', metatype: UpdateCategoryDto });

async function rejects(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
  } catch (err: any) {
    return err.getStatus();
  }
  throw new Error('expected rejection, got acceptance');
}

const GROUP_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Admin can add a category at any time, and Salem intends to as artists
 * sign up. Before this, the create endpoint wrote name, slug, sort_order
 * and group_id and nothing else — so every hand-made category landed with
 * booker_interest NULL, in none of the four buckets a booker chooses at
 * signup.
 *
 * Harmless the day it happens and invisible when it bites: the category
 * simply never appears for a booker filtering by what they came for, with
 * nothing at creation time to say so.
 */
describe('CreateCategoryDto — the booker bucket is a required choice', () => {
  it('rejects a category created without a bucket', async () => {
    expect(await rejects(() => create({ name: 'Harpist', groupId: GROUP_ID }))).toBe(400);
  });

  it('names the four buckets in the error, so the fix is obvious', async () => {
    try {
      await create({ name: 'Harpist', groupId: GROUP_ID });
    } catch (err: any) {
      expect(String(err.getResponse().message)).toContain('musical_acts');
    }
    expect.hasAssertions();
  });

  it('accepts one of the four', async () => {
    await expect(
      create({ name: 'Harpist', groupId: GROUP_ID, bookerInterest: 'musical_acts' }),
    ).resolves.toMatchObject({ bookerInterest: 'musical_acts' });
  });

  it('accepts the venues bucket', async () => {
    // Venues are a bucket of their own now: a booker looking for a room is
    // looking for something, and "I need a venue for the wedding" is as
    // ordinary a search as "I need a band".
    await expect(
      create({ name: 'Rooftop', groupId: GROUP_ID, bookerInterest: 'venues' }),
    ).resolves.toMatchObject({ bookerInterest: 'venues' });
  });

  it('no longer accepts null', async () => {
    // It briefly did, for the Venue category, which answered none of the
    // four performer buckets. With 'venues' a bucket in its own right
    // nothing legitimately has none, and a category in no bucket is
    // invisible to every booker with nothing at the time to say so.
    expect(
      await rejects(() => create({ name: 'Rooftop', groupId: GROUP_ID, bookerInterest: null })),
    ).toBe(400);
  });

  it('rejects a bucket that is not one of the four', async () => {
    expect(
      await rejects(() =>
        create({ name: 'Harpist', groupId: GROUP_ID, bookerInterest: 'caterers' }),
      ),
    ).toBe(400);
  });
});

describe('UpdateCategoryDto — omitted and null mean different things', () => {
  it('accepts an edit that does not mention the bucket', async () => {
    await expect(update({ name: 'Renamed' })).resolves.toMatchObject({ name: 'Renamed' });
  });

  it('refuses to clear it', async () => {
    // There is no category that should belong to no bucket, and clearing
    // one would hide it from every booker silently.
    expect(await rejects(() => update({ bookerInterest: null }))).toBe(400);
  });

  it('accepts changing it', async () => {
    await expect(update({ bookerInterest: 'photo_video' })).resolves.toMatchObject({
      bookerInterest: 'photo_video',
    });
  });

  it('rejects a bucket outside the four', async () => {
    expect(await rejects(() => update({ bookerInterest: 'weddings' }))).toBe(400);
  });
});
