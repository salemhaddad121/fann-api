import * as crypto from 'crypto';

/**
 * The token that lets someone unsubscribe from an email without logging in.
 *
 * That "without logging in" is the whole requirement. §24.2 asks that
 * marketing consent be withdrawable, and a withdrawal that first demands a
 * password is not a real one — the people most likely to unsubscribe are the
 * ones least likely to still have an account they can get into. So the link
 * in the email has to carry proof of who it is for.
 *
 * Stateless HMAC rather than a stored token, for two reasons. There is
 * nothing to clean up — no table of dangling tokens for people who never
 * clicked — and rotating UNSUBSCRIBE_SECRET invalidates every outstanding
 * link at once, which is the only revocation this ever needs.
 *
 * Deliberately no expiry. People unsubscribe from months-old email, and a
 * link that has quietly stopped working is indistinguishable from a link
 * that never worked — they conclude the unsubscribe is fake and mark the
 * message as spam instead, which is worse for the sender than the
 * unsubscribe was.
 *
 * On what a leaked token is worth: it permits exactly one action, stopping
 * marketing email to one address. It cannot read anything, cannot change an
 * account, and cannot be replayed into anything else. Someone who obtains it
 * can annoy the recipient by unsubscribing them; that is the whole blast
 * radius, and it is why this is a signature rather than a session.
 */

const PURPOSE = 'unsubscribe:marketing';

/**
 * Falls back to JWT_SECRET so the feature cannot silently ship unsigned if
 * UNSUBSCRIBE_SECRET is unset. Both are required at boot elsewhere, so there
 * is always something to sign with.
 */
function secretFrom(config: { get<T>(key: string): T | undefined }): string {
  const dedicated = config.get<string>('UNSUBSCRIBE_SECRET');
  if (dedicated) return dedicated;

  const jwt = config.get<string>('JWT_SECRET');
  if (!jwt) {
    throw new Error(
      'Cannot sign unsubscribe links: set UNSUBSCRIBE_SECRET or JWT_SECRET.',
    );
  }
  return jwt;
}

function sign(userId: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${PURPOSE}:${userId}`)
    .digest('base64url');
}

export function createUnsubscribeToken(
  userId: string,
  config: { get<T>(key: string): T | undefined },
): string {
  return `${userId}.${sign(userId, secretFrom(config))}`;
}

/**
 * Returns the user id a token is for, or null.
 *
 * The comparison is timingSafeEqual rather than `===`. A string compare
 * leaks how much of a guessed signature was right, one byte at a time, which
 * is enough to forge one given patience — and this endpoint is public and
 * unauthenticated, so patience is all an attacker needs.
 */
export function readUnsubscribeToken(
  token: string,
  config: { get<T>(key: string): T | undefined },
): string | null {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const userId = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  if (!userId || !provided) return null;

  const expected = sign(userId, secretFrom(config));

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself a signal —
  // so the lengths are compared first and in the open. Length is not secret;
  // the bytes are.
  if (a.length !== b.length) return null;

  return crypto.timingSafeEqual(a, b) ? userId : null;
}
