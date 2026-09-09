import { BadRequestException } from '@nestjs/common';
import { ConsentService } from './consent.service';
import { CONSENT_VERSIONS } from './consent.constants';
import { createMockDb, createMockQueryBuilder } from '../test-utils/knex-mock';

const TABLE = 'user_consents';

function makeService(latestRow?: unknown) {
  const consents = createMockQueryBuilder();
  consents.first.mockResolvedValue(latestRow);
  const db = createMockDb({ [TABLE]: consents });
  return { service: new ConsentService(db), consents };
}

describe('ConsentService', () => {
  describe('record', () => {
    it('marks every document it writes as granted, with the contact snapshot', async () => {
      const { service, consents } = makeService();

      await service.record('user-1', ['terms', 'privacy'], {
        contactEmail: 'signup@example.com',
      });

      const rows = consents.insert.mock.calls[0][0];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.granted).toBe(true);
        // Snapshotted, not joined — users.email changes and this must not.
        expect(row.contact_email).toBe('signup@example.com');
      }
    });

    it('stamps the version live for each document', async () => {
      const { service, consents } = makeService();

      await service.record('user-1', ['marketing']);

      expect(consents.insert.mock.calls[0][0][0].version).toBe(CONSENT_VERSIONS.marketing);
    });

    it('writes nothing when given no documents', async () => {
      const { service, consents } = makeService();

      await service.record('user-1', []);

      expect(consents.insert).not.toHaveBeenCalled();
    });
  });

  describe('setConsent', () => {
    it('appends a withdrawal rather than updating the existing row', async () => {
      // The table is the evidence. "Granted on the 3rd, withdrawn on the
      // 9th" is the fact worth keeping; an UPDATE would leave only the
      // final state and throw away what actually happened.
      const { service, consents } = makeService();

      await service.setConsent('user-1', 'marketing', false);

      expect(consents.insert).toHaveBeenCalledTimes(1);
      expect(consents.insert.mock.calls[0][0].granted).toBe(false);
      expect(consents.update).not.toHaveBeenCalled();
    });

    it('refuses to withdraw the Terms', async () => {
      // Not a preference — revoking the Terms is closing the account, which
      // is a different flow. Accepting it here would leave a signed-in user
      // on record as having revoked the terms they are using the site under.
      const { service, consents } = makeService();

      await expect(service.setConsent('user-1', 'terms', false)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(consents.insert).not.toHaveBeenCalled();
    });

    it('refuses the Privacy Policy for the same reason', async () => {
      const { service } = makeService();

      await expect(
        service.setConsent('user-1', 'privacy', false),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('isGranted', () => {
    it('is false when the user was never asked', async () => {
      // Absent must not read as permission to email someone.
      const { service } = makeService(undefined);

      await expect(service.isGranted('user-1', 'marketing')).resolves.toBe(false);
    });

    it('is false when the latest row is a withdrawal', async () => {
      const { service } = makeService({ granted: false });

      await expect(service.isGranted('user-1', 'marketing')).resolves.toBe(false);
    });

    it('is true when the latest row is a grant', async () => {
      const { service } = makeService({ granted: true });

      await expect(service.isGranted('user-1', 'marketing')).resolves.toBe(true);
    });

    it('reads the newest row first, so a re-grant beats an older withdrawal', async () => {
      const { service, consents } = makeService({ granted: true });

      await service.isGranted('user-1', 'marketing');

      expect(consents.orderBy).toHaveBeenCalledWith('accepted_at', 'desc');
    });
  });
});

describe('outdatedDocuments', () => {
  function makeServiceWithRows(rows: unknown[]) {
    const consents = createMockQueryBuilder();
    consents.mockResolve(rows);
    return new ConsentService(createMockDb({ [TABLE]: consents }));
  }

  function accepted(document: string, version: string) {
    return { document, version, accepted_at: new Date(), granted: true };
  }

  it('names both documents for an account that never accepted anything', async () => {
    // Accounts predating consent recording have no rows. Treating that as
    // settled would leave users the platform can show no acceptance for.
    const service = makeServiceWithRows([]);

    await expect(service.outdatedDocuments('user-1')).resolves.toEqual([
      'terms',
      'privacy',
    ]);
  });

  it('is empty when both are accepted at the current version', async () => {
    const service = makeServiceWithRows([
      accepted('terms', CONSENT_VERSIONS.terms),
      accepted('privacy', CONSENT_VERSIONS.privacy),
    ]);

    await expect(service.outdatedDocuments('user-1')).resolves.toEqual([]);
  });

  it('names only the document whose version moved', async () => {
    // The case §33.2 is about: one document is amended, the other is not.
    const service = makeServiceWithRows([
      accepted('terms', '2020-01-01'),
      accepted('privacy', CONSENT_VERSIONS.privacy),
    ]);

    await expect(service.outdatedDocuments('user-1')).resolves.toEqual(['terms']);
  });

  it('never asks about marketing', async () => {
    // Not having marketing consent is a valid permanent state, not
    // something to be prompted about.
    const service = makeServiceWithRows([
      accepted('terms', CONSENT_VERSIONS.terms),
      accepted('privacy', CONSENT_VERSIONS.privacy),
    ]);

    await expect(service.outdatedDocuments('user-1')).resolves.not.toContain('marketing');
  });

  it('reads the newest acceptance, so re-accepting clears the prompt', async () => {
    // listForUser returns newest-first; the first row per document wins.
    const service = makeServiceWithRows([
      accepted('terms', CONSENT_VERSIONS.terms),
      accepted('terms', '2020-01-01'),
      accepted('privacy', CONSENT_VERSIONS.privacy),
    ]);

    await expect(service.outdatedDocuments('user-1')).resolves.toEqual([]);
  });
});
