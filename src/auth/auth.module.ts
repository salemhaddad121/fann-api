import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { ConsentModule } from '../consent/consent.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy }    from './strategies/jwt.strategy';
import { LocalStrategy }  from './strategies/local.strategy';
import { GoogleStrategy } from './strategies/google.strategy';
import { AppleStrategy }  from './strategies/apple.strategy';
import {
  AppleConfiguredGuard,
  GoogleConfiguredGuard,
} from './guards/oauth-configured.guard';
import {
  APPLE_ENV_KEYS,
  GOOGLE_ENV_KEYS,
  missingOAuthKeys,
} from './oauth-config.util';

const logger = new Logger('AuthModule');

/**
 * A Passport strategy registers itself with Passport from its constructor,
 * so "don't register this provider" and "don't construct it" are the same
 * thing. These factories skip construction when the provider's credentials
 * are absent — previously the strategy was constructed unconditionally and
 * passport-google-oauth20 / passport-apple threw on the empty clientID,
 * killing the process at bootstrap before it bound to a port.
 *
 * Everything else (email/password login, JWT cookies) is unaffected, so an
 * install with no OAuth credentials now boots and works normally; only the
 * /auth/google and /auth/apple routes are unavailable, and they answer 503
 * via the guards rather than an opaque Passport 500.
 */
const googleStrategyProvider = {
  provide: GoogleStrategy,
  inject: [ConfigService, AuthService],
  useFactory: (config: ConfigService, authService: AuthService) => {
    const missing = missingOAuthKeys(config, GOOGLE_ENV_KEYS);
    if (missing.length > 0) {
      logger.warn(
        `Google sign-in disabled — missing ${missing.join(', ')}. ` +
          'GET /auth/google will return 503 until these are set.',
      );
      return null;
    }
    return new GoogleStrategy(config, authService);
  },
};

const appleStrategyProvider = {
  provide: AppleStrategy,
  inject: [ConfigService, AuthService],
  useFactory: (config: ConfigService, authService: AuthService) => {
    const missing = missingOAuthKeys(config, APPLE_ENV_KEYS);
    if (missing.length > 0) {
      logger.warn(
        `Apple sign-in disabled — missing ${missing.join(', ')}. ` +
          'GET /auth/apple will return 503 until these are set.',
      );
      return null;
    }
    return new AppleStrategy(config, authService);
  },
};

@Module({
  imports: [
    UsersModule,
    ConsentModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject:  [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Access token config — refresh token is signed manually in AuthService
        secret:      config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    LocalStrategy,
    JwtStrategy,
    googleStrategyProvider,
    appleStrategyProvider,
    GoogleConfiguredGuard,
    AppleConfiguredGuard,
  ],
  exports: [AuthService],
})
export class AuthModule {}
