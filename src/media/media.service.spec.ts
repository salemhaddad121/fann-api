import { MediaService } from './media.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/put'),
}));

// confirm() asks S3 whether the object is really there before writing a row
// (H2), and remove() deletes it after the row is gone (M6). Both need the
// client under control rather than reaching the network.
const s3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({
      send: (...args: unknown[]) => s3Send(...args),
    })),
  };
});

/** A HeadObject answer for an object that exists at the declared size. */
function objectExists(bytes = 1024) {
  return { ContentLength: bytes, $metadata: { httpStatusCode: 200 } };
}

/** What the SDK throws for a key that is not in the bucket. */
function notFound() {
  return Object.assign(new Error('NotFound'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
}

beforeEach(() => {
  s3Send.mockReset();
  // Default: the object is there. Individual cases override.
  s3Send.mockResolvedValue(objectExists());
});

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


// ----------------------------------------------------------------
// H2 — the ownership prefix check was correct; the existence check was
// missing. A row could be written, and artist_profiles.thumbnail_url set,
// for a key that was never uploaded: a broken image on a public profile
// and a blank thumbnail in search, with a database that believes
// everything is fine.
// ----------------------------------------------------------------
describe('MediaService.confirm() — the object actually exists', () => {
  const key = `uploads/${OWNER}/never-uploaded.jpg`;

  function confirmDto(overrides: Record<string, unknown> = {}) {
    return {
      s3Key: key,
      mediaType: 'photo',
      fileSizeBytes: 1024,
      ...overrides,
    } as never;
  }

  it('rejects a key that was never uploaded', async () => {
    s3Send.mockRejectedValueOnce(notFound());
    const service = new MediaService(emptyMediaDb(), configStub());

    await expect(service.confirm(OWNER, confirmDto())).rejects.toThrow(
      'That upload was not found in storage. Please upload the file again.',
    );
  });

  it('writes no row when the object is absent', async () => {
    s3Send.mockRejectedValueOnce(notFound());
    const media = createMockQueryBuilder();
    media.first
      .mockResolvedValueOnce({ count: '0' })
      .mockResolvedValueOnce({ maxSort: null });
    const service = new MediaService(createMockDb({ media }), configStub());

    await service.confirm(OWNER, confirmDto()).catch(() => undefined);

    expect(media.insert).not.toHaveBeenCalled();
  });

  it('asks S3 before it asks the database', async () => {
    const service = new MediaService(emptyMediaDb(), configStub());

    await service.confirm(OWNER, confirmDto());

    const sent = s3Send.mock.calls[0][0];
    expect(sent.constructor.name).toBe('HeadObjectCommand');
    expect(sent.input).toMatchObject({ Bucket: 'fann-media', Key: key });
  });

  it('rejects an object whose real size is not the size declared', async () => {
    // file_size_bytes is client-supplied and is what the cap logic and
    // profile completeness read, so a 40 MB video declared as 1 KB would
    // otherwise be taken on the client's word.
    s3Send.mockResolvedValueOnce(objectExists(40 * 1024 * 1024));
    const service = new MediaService(emptyMediaDb(), configStub());

    await expect(service.confirm(OWNER, confirmDto({ fileSizeBytes: 1024 }))).rejects.toThrow(
      'The uploaded file does not match the size that was declared.',
    );
  });

  it('does not blame the caller for a storage outage', async () => {
    // A 403 or a timeout is not a bad request and must not be reported as
    // one — that would tell the user to re-upload a file that is fine.
    s3Send.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { $metadata: { httpStatusCode: 503 } }),
    );
    const service = new MediaService(emptyMediaDb(), configStub());

    await expect(service.confirm(OWNER, confirmDto())).rejects.toThrow('timeout');
  });
});

// ----------------------------------------------------------------
// M14 — the 20-item cap was a count-then-insert with no constraint
// behind it. sort_order and is_primary were derived the same way and are
// wrong under concurrency for the same reason.
// ----------------------------------------------------------------
describe('MediaService.confirm() — the cap is not a suggestion', () => {
  function dbAt(count: number) {
    const media = createMockQueryBuilder();
    media.first
      .mockResolvedValueOnce({ count: String(count) })
      .mockResolvedValueOnce({ maxSort: count === 0 ? null : count - 1 });
    media.returning.mockResolvedValue([{ id: 'media-1' }]);
    return { db: createMockDb({ media }), media };
  }

  it('takes a per-user lock before counting', async () => {
    // A transaction alone does not fix this: under READ COMMITTED the
    // second transaction's count does not see the first's uncommitted row,
    // so two uploads at 19 both pass and 21 land.
    const { db } = dbAt(0);
    const service = new MediaService(db, configStub());

    await service.confirm(OWNER, {
      s3Key: `uploads/${OWNER}/a.jpg`,
      mediaType: 'photo',
      fileSizeBytes: 1024,
    } as never);

    expect(db.transaction).toHaveBeenCalled();
    expect(db.raw).toHaveBeenCalledWith(
      expect.stringContaining('pg_advisory_xact_lock'),
      [`media:${OWNER}`],
    );
  });

  it('still refuses the 21st item', async () => {
    const { db, media } = dbAt(20);
    const service = new MediaService(db, configStub());

    await expect(
      service.confirm(OWNER, {
        s3Key: `uploads/${OWNER}/a.jpg`,
        mediaType: 'photo',
        fileSizeBytes: 1024,
      } as never),
    ).rejects.toThrow('Maximum of 20 media items per profile.');
    expect(media.insert).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// M6 — remove() called S3 DeleteObject BEFORE the database delete with no
// error handling, so any storage error threw and left the row behind. The
// user pressed delete, got a 500, and the photo was still on the profile.
// ----------------------------------------------------------------
describe('MediaService.remove() — storage failure is survivable', () => {
  function ownedRow() {
    const media = createMockQueryBuilder();
    media.first.mockResolvedValue({
      id: 'media-1',
      user_id: OWNER,
      s3_key: `uploads/${OWNER}/abc.jpg`,
      is_primary: false,
    });
    return media;
  }

  it('deletes the row even when the object cannot be deleted', async () => {
    s3Send.mockRejectedValue(new Error('R2 is having a bad minute'));
    const media = ownedRow();
    const service = new MediaService(createMockDb({ media }), configStub());
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    await expect(service.remove(OWNER, 'media-1')).resolves.toEqual({
      message: 'Media deleted.',
    });
    expect(media.delete).toHaveBeenCalled();
  });

  it('logs the orphaned key so it can be swept', async () => {
    s3Send.mockRejectedValue(new Error('nope'));
    const service = new MediaService(createMockDb({ media: ownedRow() }), configStub());
    const spy = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    await service.remove(OWNER, 'media-1');

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining(`uploads/${OWNER}/abc.jpg`),
    );
  });

  it('deletes the row before attempting the object', async () => {
    const media = ownedRow();
    const service = new MediaService(createMockDb({ media }), configStub());

    await service.remove(OWNER, 'media-1');

    expect(media.delete).toHaveBeenCalled();
    const deleteCommand = s3Send.mock.calls.at(-1)?.[0];
    expect(deleteCommand.constructor.name).toBe('DeleteObjectCommand');
  });
});
