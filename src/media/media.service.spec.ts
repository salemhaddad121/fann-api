import { MediaService } from './media.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/put'),
}));

const OWNER = 'user-1';
const ATTACKER = 'user-2';

function configStub() {
  const values: Record<string, string> = {
    AWS_REGION: 'auto',
    AWS_ACCESS_KEY_ID: 'key',
    AWS_SECRET_ACCESS_KEY: 'secret',
    S3_BUCKET: 'fann-media',
    CDN_BASE_URL: 'https://cdn.fann.guru',
  };
  return {
    get: jest.fn((k: string) => values[k]),
    getOrThrow: jest.fn((k: string) => values[k]),
  } as any;
}

/** A db where the caller has no media yet, so confirm() reaches the insert. */
function emptyMediaDb() {
  const media = createMockQueryBuilder();
  media.first
    .mockResolvedValueOnce({ count: '0' }) // existing item count
    .mockResolvedValueOnce({ maxSort: null }); // current max sort_order
  media.returning.mockResolvedValue([{ id: 'media-1' }]);
  return createMockDb({ media });
}

describe('MediaService.confirm() — key ownership', () => {
  it('rejects a key belonging to another user', async () => {
    // Not a theoretical key-guessing problem. cdn_url is
    // `${CDN_BASE_URL}/${s3_key}`, so every photo on a public profile
    // publishes its own key. Confirming someone else's key creates a row
    // the attacker owns pointing at the victim's object — and remove()
    // then deletes that object from the bucket on their say-so.
    const service = new MediaService(emptyMediaDb(), configStub());

    await expect(
      service.confirm(ATTACKER, {
        s3Key: `uploads/${OWNER}/9f8e7d6c-1111-2222-3333-444455556666.jpg`,
        mediaType: 'photo',
        fileSizeBytes: 1024,
      } as any),
    ).rejects.toThrow('That upload does not belong to you.');
  });

  it('rejects a key outside the uploads prefix entirely', async () => {
    // identity/ is the prefix holding ID scans and selfies. Nothing in the
    // public media pipeline may ever point at one.
    const service = new MediaService(emptyMediaDb(), configStub());

    await expect(
      service.confirm(ATTACKER, {
        s3Key: `identity/${OWNER}/id_document-abc.jpg`,
        mediaType: 'photo',
        fileSizeBytes: 1024,
      } as any),
    ).rejects.toThrow('That upload does not belong to you.');
  });

  it('rejects a prefix that merely starts with the caller id', async () => {
    // `uploads/user-10/...` must not pass the check for `user-1`.
    const service = new MediaService(emptyMediaDb(), configStub());

    await expect(
      service.confirm('user-1', {
        s3Key: 'uploads/user-10/aaaa.jpg',
        mediaType: 'photo',
        fileSizeBytes: 1024,
      } as any),
    ).rejects.toThrow('That upload does not belong to you.');
  });

  it('accepts the key presign() issued to that same caller', async () => {
    const db = emptyMediaDb();
    const service = new MediaService(db, configStub());

    const { s3Key } = await service.presign(OWNER, {
      mediaType: 'photo',
      filename: 'headshot.jpg',
      fileSizeBytes: 1024,
    } as any);

    await expect(
      service.confirm(OWNER, {
        s3Key,
        mediaType: 'photo',
        fileSizeBytes: 1024,
      } as any),
    ).resolves.toEqual({ id: 'media-1' });
  });

  it('builds the cdn url from the confirmed key', async () => {
    const db = emptyMediaDb();
    const service = new MediaService(db, configStub());

    await service.confirm(OWNER, {
      s3Key: `uploads/${OWNER}/abc.jpg`,
      mediaType: 'photo',
      fileSizeBytes: 1024,
    } as any);

    const [row] = db('media').insert.mock.calls[0];
    expect(row.cdn_url).toBe(`https://cdn.fann.guru/uploads/${OWNER}/abc.jpg`);
    // First photo becomes the primary automatically.
    expect(row.is_primary).toBe(true);
  });
});

describe('MediaService.presign()', () => {
  it('issues keys under the caller own prefix', async () => {
    const service = new MediaService(emptyMediaDb(), configStub());

    const { s3Key } = await service.presign(OWNER, {
      mediaType: 'photo',
      filename: 'headshot.JPG',
      fileSizeBytes: 2048,
    } as any);

    expect(s3Key.startsWith(`uploads/${OWNER}/`)).toBe(true);
    // Extension is lowercased so the MIME lookup is case-insensitive.
    expect(s3Key.endsWith('.jpg')).toBe(true);
  });

  it('refuses a file type it has no content type for', async () => {
    const service = new MediaService(emptyMediaDb(), configStub());

    await expect(
      service.presign(OWNER, {
        mediaType: 'photo',
        filename: 'payload.svg',
        fileSizeBytes: 100,
      } as any),
    ).rejects.toThrow('Unsupported file type: .svg');
  });

  it('requires a duration for a video', async () => {
    const service = new MediaService(emptyMediaDb(), configStub());

    await expect(
      service.presign(OWNER, {
        mediaType: 'video',
        filename: 'set.mp4',
        fileSizeBytes: 100,
      } as any),
    ).rejects.toThrow('Video duration is required.');
  });

  it('enforces the photo size cap', async () => {
    const service = new MediaService(emptyMediaDb(), configStub());

    await expect(
      service.presign(OWNER, {
        mediaType: 'photo',
        filename: 'huge.png',
        fileSizeBytes: 11 * 1024 * 1024,
      } as any),
    ).rejects.toThrow('Photos must be 10 MB or smaller.');
  });
});

describe('MediaService.remove()', () => {
  it('refuses to touch a row owned by someone else', async () => {
    const media = createMockQueryBuilder();
    media.first.mockResolvedValueOnce({
      id: 'media-1',
      user_id: OWNER,
      s3_key: `uploads/${OWNER}/abc.jpg`,
    });
    const service = new MediaService(createMockDb({ media }), configStub());

    await expect(service.remove(ATTACKER, 'media-1')).rejects.toThrow('Not your media.');
  });

  it('404s on a row that does not exist', async () => {
    const media = createMockQueryBuilder();
    media.first.mockResolvedValueOnce(undefined);
    const service = new MediaService(createMockDb({ media }), configStub());

    await expect(service.remove(OWNER, 'nope')).rejects.toThrow('Media item not found.');
  });
});

describe('MediaService.setPrimary()', () => {
  it('refuses a row owned by someone else', async () => {
    const media = createMockQueryBuilder();
    media.first.mockResolvedValueOnce({
      id: 'media-1',
      user_id: OWNER,
      media_type: 'photo',
    });
    const service = new MediaService(createMockDb({ media }), configStub());

    await expect(service.setPrimary(ATTACKER, 'media-1')).rejects.toThrow('Not your media.');
  });

  it('refuses to make a video the primary', async () => {
    const media = createMockQueryBuilder();
    media.first.mockResolvedValueOnce({
      id: 'media-1',
      user_id: OWNER,
      media_type: 'video',
    });
    const service = new MediaService(createMockDb({ media }), configStub());

    await expect(service.setPrimary(OWNER, 'media-1')).rejects.toThrow(
      'Only photos can be set as primary.',
    );
  });
});
