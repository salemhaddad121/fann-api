import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-apple';
import { AuthService } from '../auth.service';
import { UserRole } from '../../users/users.types';
import { requireConfig } from '../../common/config.util';

@Injectable()
export class AppleStrategy extends PassportStrategy(Strategy, 'apple') {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      clientID:    requireConfig(configService, 'APPLE_CLIENT_ID'),    // Service ID
      teamID:      requireConfig(configService, 'APPLE_TEAM_ID'),
      keyID:       requireConfig(configService, 'APPLE_KEY_ID'),
      privateKeyString: requireConfig(configService, 'APPLE_PRIVATE_KEY'),
      callbackURL: requireConfig(configService, 'APPLE_CALLBACK_URL'),
      passReqToCallback: true,
      scope: ['email', 'name'],
    });
  }

  async validate(
    req: any,
    _accessToken: string,
    _refreshToken: string,
    idToken: any,
    profile: any,
    done: Function,
  ) {
    // Apple only sends name/email on the very first login
    const email = idToken?.email ?? profile?.email;
    const role  = (req.body?.state as UserRole) ?? 'artist';

    const user = await this.authService.findOrCreateOAuthUser({
      provider:    'apple',
      providerUid: idToken.sub,
      email,
      role,
    });

    done(null, user);
  }
}
