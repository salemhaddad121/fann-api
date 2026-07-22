import { ConfigService } from '@nestjs/config';

/**
 * Single source of truth for "is this OAuth provider actually configured?".
 *
 * passport-google-oauth20 and passport-apple both throw synchronously from
 * their constructors when handed an empty clientID — which, since Nest
 * instantiates every provider at bootstrap, took the whole process down
 * before it ever listened on a port. The shipped .env.example leaves these
 * blank, so a default checkout could not boot at all.
 *
 * Both the module (which skips constructing an unconfigured strategy) and
 * the route guard (which returns a clean 503 instead of an opaque Passport
 * error) read the answer from here, so they can't drift apart.
 */

export const GOOGLE_ENV_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CALLBACK_URL',
] as const;

export const APPLE_ENV_KEYS = [
  'APPLE_CLIENT_ID',
  'APPLE_TEAM_ID',
  'APPLE_KEY_ID',
  'APPLE_PRIVATE_KEY',
  'APPLE_CALLBACK_URL',
] as const;

/** Which of `keys` are missing or blank. Empty array means fully configured. */
export function missingOAuthKeys(
  config: ConfigService,
  keys: readonly string[],
): string[] {
  return keys.filter((key) => !config.get<string>(key)?.trim());
}

export function isOAuthConfigured(
  config: ConfigService,
  keys: readonly string[],
): boolean {
  return missingOAuthKeys(config, keys).length === 0;
}
