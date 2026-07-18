import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import { JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET'),
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
