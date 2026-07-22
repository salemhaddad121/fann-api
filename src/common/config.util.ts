import { ConfigService } from '@nestjs/config';

/**
 * Reads a required environment variable, throwing a clear error naming the
 * missing key rather than passing `undefined` further down.
 *
 * ConfigService.get() is typed `string | undefined`, and the Passport
 * typings (correctly) refuse that — a strategy handed an undefined secret
 * or clientID fails at some later, much less obvious point. Failing at
 * bootstrap with the variable's name is far easier to act on.
 */
export function requireConfig(config: ConfigService, key: string): string {
  const value = config.get<string>(key)?.trim();

  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. ` +
        'See .env.example for the full list.',
    );
  }

  return value;
}
