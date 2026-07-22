import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { UsersService } from '../../users/users.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { ACCESS_TOKEN_COOKIE } from '../auth-cookie.util';
import { requireConfig } from '../../common/config.util';

// Reads the access token from the httpOnly cookie set by /auth/login,
// /auth/refresh, and the OAuth callbacks. Falls back to a Bearer header
// so a future non-browser client (e.g. the React Native app mentioned in
// the project's longer-term plans) can still authenticate without cookies,
// which don't work the same way outside a browser.
const cookieExtractor = (req: Request): string | null => {
  return req?.cookies?.[ACCESS_TOKEN_COOKIE] ?? null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        cookieExtractor,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: requireConfig(configService, 'JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload) {
    // Re-fetch on every request so status changes (suspend/ban) take effect immediately.
    const user = await this.usersService.findById(payload.sub);
    if (!user) throw new UnauthorizedException('User not found.');
    if (user.status === 'suspended') throw new UnauthorizedException('Account suspended.');
    if (user.status === 'banned')    throw new UnauthorizedException('Account banned.');
    return user;
  }
}
