import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-apple';
import { AuthService } from '../auth.service';
import { UserRole } from '../../users/users.types';

@Injectable()
export class AppleStrategy extends PassportStrategy(Strategy, 'apple') {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      clientID:    configService.get<string>('APPLE_CLIENT_ID'),    // Service ID
      teamID:      configService.get<string>('APPLE_TEAM_ID'),
      keyID:       configService.get<string>('APPLE_KEY_ID'),
      privateKeyString: configService.get<string>('APPLE_PRIVATE_KEY'),
      callbackURL: configService.get<string>('APPLE_CALLBACK_URL'),
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
