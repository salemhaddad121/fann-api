import { BadRequestException } from '@nestjs/common';
import { IdentityDocumentsService } from './identity-documents.service';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

const config = {
  get: jest.fn((key: string) => {
    const values: Record<string, string> = {
      S3_BUCKET: 'fann-media',
      AWS_REGION: 'auto',
      AWS_ACCESS_KEY_ID: 'key',
      AWS_SECRET_ACCESS_KEY: 'secret',
    };
    return values[key];
  }),
  getOrThrow: jest.fn((key: string) => {
    const values: Record<string, string> = {
      S3_BUCKET: 'fann-media',
      AWS_REGION: 'auto',
      AWS_ACCESS_KEY_ID: 'key',
      AWS_SECRET_ACCESS_KEY: 'secret',
    };
    return values[key];
  }),
} as any;

function makeService(builders: Record<string, ReturnType<typeof createMockQueryBuilder>> = {}) {
  return new IdentityDocumentsService(createMockDb(builders), config);
}

describe('IdentityDocumentsService.presign()', () => {
  it('rejects a file type it cannot serve back', async () => {
    const service = makeService();

    await expect(
      service.presign('user-1', { kind: 'id_document', filename: 'passport.exe', fileSizeBytes: 100 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a PDF as a selfie', async () => {
    // A PDF "selfie" is a scan of something else — the point of the selfie
    // is a live photo of the person holding the account.
    const service = makeService();

    await expect(
      service.presign('user-1', { kind: 'selfie', filename: 'me.pdf', fileSizeBytes: 100 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a PDF as an ID document', async () => {
    const service = makeService();

    const result = await service.presign('user-1', {
      kind: 'id_document',
      filename: 'passport.pdf',
      fileSizeBytes: 1000,
    });

    expect(result.s3Key).toMatch(/^identity\/user-1\/id_document-/);
  });

  it('rejects an oversized file', async () => {
    const service = makeService();

    await expect(
      service.presign('user-1', {
        kind: 'selfie',
        filename: 'me.jpg',
        fileSizeBytes: 50 * 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('writes to the identity prefix, never the public uploads prefix', async () => {
    // Profile media lives under uploads/ and is served from the CDN by URL.
    // An identity document on that path would be publicly fetchable.
    const service = makeService();

    const result = await service.presign('user-1', {
      kind: 'selfie',
      filename: 'me.jpg',
      fileSizeBytes: 1000,
    });

    expect(result.s3Key.startsWith('identity/')).toBe(true);
    expect(result.s3Key.startsWith('uploads/')).toBe(false);
  });
});

describe('IdentityDocumentsService.confirm()', () => {
  it("refuses a key that belongs to someone else", async () => {
    // The key comes from the client, so it is checked rather than trusted —
    // otherwise a caller could point their row at another user's upload.
    const service = makeService();

    await expect(
      service.confirm('user-1', { kind: 'selfie', s3Key: 'identity/user-2/selfie-abc.jpg' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('resets an existing document back to pending on re-upload', async () => {
    // An artist correcting a rejected photo must not need an admin to
    // delete the old row first, and a prior approval must not survive the
    // file it was based on being replaced.
    const docs = createMockQueryBuilder();
    docs.returning.mockResolvedValueOnce([{ id: 'doc-1', kind: 'selfie', status: 'pending' }]);
    const service = makeService({ id_documents: docs });

    await service.confirm('user-1', { kind: 'selfie', s3Key: 'identity/user-1/selfie-abc.jpg' });

    expect(docs.insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', reviewed_by: null, reviewed_at: null }),
    );
    expect(docs.onConflict).toHaveBeenCalledWith(['user_id', 'kind']);
  });
});

describe('IdentityDocumentsService.hasCompleteVerification()', () => {
  function withApproved(kinds: string[]) {
    const docs = createMockQueryBuilder();
    docs.mockResolve(kinds.map((kind) => ({ kind })));
    return makeService({ id_documents: docs });
  }

  it('is true only when both artefacts are approved', async () => {
    await expect(
      withApproved(['id_document', 'selfie']).hasCompleteVerification('user-1'),
    ).resolves.toBe(true);
  });

  it('is false with only the ID approved', async () => {
    // The half-verified case is the one that matters: approving an ID must
    // not be enough to publish an artist.
    await expect(
      withApproved(['id_document']).hasCompleteVerification('user-1'),
    ).resolves.toBe(false);
  });

  it('is false with only the selfie approved', async () => {
    await expect(withApproved(['selfie']).hasCompleteVerification('user-1')).resolves.toBe(false);
  });

  it('is false with nothing approved', async () => {
    await expect(withApproved([]).hasCompleteVerification('user-1')).resolves.toBe(false);
  });
});

describe('IdentityDocumentsService.getMine()', () => {
  it('reports both required kinds even when nothing is uploaded', async () => {
    // The UI renders a checklist from this, so an absent document has to
    // come back as "missing" rather than simply not appearing.
    const docs = createMockQueryBuilder();
    docs.mockResolve([]);
    const service = makeService({ id_documents: docs });

    const result = await service.getMine('user-1');

    expect(result.documents.map((d) => d.kind)).toEqual(['id_document', 'selfie']);
    expect(result.documents.every((d) => d.status === 'missing')).toBe(true);
    expect(result.complete).toBe(false);
  });

  it('says what is outstanding in words a person can act on', async () => {
    const docs = createMockQueryBuilder();
    docs.mockResolve([
      { kind: 'id_document', status: 'approved' },
      { kind: 'selfie', status: 'rejected', rejection_reason: 'Too blurry' },
    ]);
    const service = makeService({ id_documents: docs });

    const result = await service.getMine('user-1');

    expect(result.complete).toBe(false);
    expect(result.outstanding).toEqual(['Your selfie was rejected — upload a new one']);
  });

  it('is complete only when both are approved', async () => {
    const docs = createMockQueryBuilder();
    docs.mockResolve([
      { kind: 'id_document', status: 'approved' },
      { kind: 'selfie', status: 'approved' },
    ]);
    const service = makeService({ id_documents: docs });

    const result = await service.getMine('user-1');

    expect(result.complete).toBe(true);
    expect(result.outstanding).toEqual([]);
  });
});
