import {
  createUnsubscribeToken,
  readUnsubscribeToken,
} from './unsubscribe-token';

const config = (values: Record<string, string | undefined>) => ({
  get: <T>(key: string) => values[key] as T | undefined,
});

const SECRET = config({ UNSUBSCRIBE_SECRET: 'a-test-secret' });
const USER = '00000000-0000-0000-0000-000000000011';

describe('unsubscribe token', () => {
  it('round-trips the user it was made for', () => {
    const token = createUnsubscribeToken(USER, SECRET);

    expect(readUnsubscribeToken(token, SECRET)).toBe(USER);
  });

  it('is stable, so a link in an old email still works', () => {
    // No expiry by design: a dead unsubscribe link reads as a fake one, and
    // the recipient marks the message as spam instead.
    expect(createUnsubscribeToken(USER, SECRET)).toBe(
      createUnsubscribeToken(USER, SECRET),
    );
  });

  it('gives a different token to a different user', () => {
    const other = '00000000-0000-0000-0000-000000000022';

    expect(createUnsubscribeToken(USER, SECRET)).not.toBe(
      createUnsubscribeToken(other, SECRET),
    );
  });

  it('rejects a token whose signature has been altered', () => {
    const token = createUnsubscribeToken(USER, SECRET);
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');

    expect(readUnsubscribeToken(tampered, SECRET)).toBeNull();
  });

  it('rejects someone else’s id pasted onto a valid signature', () => {
    // The attack the signature exists to stop: unsubscribing a stranger by
    // editing the id in your own link.
    const token = createUnsubscribeToken(USER, SECRET);
    const signature = token.slice(token.lastIndexOf('.') + 1);

    expect(
      readUnsubscribeToken(`00000000-0000-0000-0000-000000000022.${signature}`, SECRET),
    ).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    // Which is what makes rotating UNSUBSCRIBE_SECRET a revocation.
    const token = createUnsubscribeToken(USER, config({ UNSUBSCRIBE_SECRET: 'old' }));

    expect(readUnsubscribeToken(token, config({ UNSUBSCRIBE_SECRET: 'new' }))).toBeNull();
  });

  it.each([[''], ['nonsense'], ['.'], ['no-dot-at-all'], ['.onlysignature'], ['onlyid.']])(
    'rejects the malformed token %p without throwing',
    (token) => {
      expect(readUnsubscribeToken(token, SECRET)).toBeNull();
    },
  );

  it('falls back to JWT_SECRET so links are never unsigned', () => {
    const fallback = config({ JWT_SECRET: 'jwt-secret' });
    const token = createUnsubscribeToken(USER, fallback);

    expect(readUnsubscribeToken(token, fallback)).toBe(USER);
  });

  it('refuses to sign when there is no secret at all', () => {
    // Failing loudly beats shipping a link anyone can forge.
    expect(() => createUnsubscribeToken(USER, config({}))).toThrow(/secret/i);
  });
});
