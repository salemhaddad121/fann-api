import {
  CanActivate,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  APPLE_ENV_KEYS,
  GOOGLE_ENV_KEYS,
  missingOAuthKeys,
} from '../oauth-config.util';

/**
 * Runs *before* AuthGuard('google'|'apple') on the OAuth routes.
 *
 * When a provider isn't configured its Passport strategy is never
 * registered (see auth.module.ts), so AuthGuard would fail with an opaque
 * "Unknown authentication strategy" 500. These guards turn that into a 503
 * that says what's actually wrong.
 */
function assertConfigured(
  config: ConfigService,
  provider: string,
  keys: readonly string[],
): boolean {
  const missing = missingOAuthKeys(config, keys);
  if (missing.length > 0) {
    throw new ServiceUnavailableException(
      `${provider} sign-in is not configured on this server. ` +
        `Missing environment variables: ${missing.join(', ')}.`,
    );
  }
  return true;
}

@Injectable()
export class GoogleConfiguredGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    return assertConfigured(this.config, 'Google', GOOGLE_ENV_KEYS);
  }
}

@Injectable()
export class AppleConfiguredGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    return assertConfigured(this.config, 'Apple', APPLE_ENV_KEYS);
  }
}
