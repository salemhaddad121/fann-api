import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { AuthService } from '../auth.service';
import { UserRole } from '../../users/users.types';
import { requireConfig } from '../../common/config.util';
import { clientIp } from '../../common/request.util';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      clientID:     requireConfig(configService, 'GOOGLE_CLIENT_ID'),
      clientSecret: requireConfig(configService, 'GOOGLE_CLIENT_SECRET'),
      callbackURL:  requireConfig(configService, 'GOOGLE_CALLBACK_URL'),
      // Pass `state` through so we know which role the user registered as
      passReqToCallback: true,
      scope: ['email', 'profile'],
    });
  }

  async validate(
    req: any,
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ) {
    const email    = profile.emails?.[0]?.value;
    const role     = (req.query?.state as UserRole) ?? 'artist';

    // The same evidence register() captures. A consent row without the
    // address and client that made the acceptance is weak evidence, and the
    // OAuth path now writes those rows too.
    const user = await this.authService.findOrCreateOAuthUser(
      {
        provider:    'google',
        providerUid: profile.id,
        email,
        role,
      },
      {
        ipAddress: clientIp(req),
        userAgent: req.headers?.['user-agent'] ?? null,
      },
    );

    done(null, user);
  }
}
