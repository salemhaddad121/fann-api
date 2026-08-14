import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ROLES_KEY } from '../decorators/auth.decorators';
import { UserRole } from '../../users/users.types';

// ----------------------------------------------------------------
// JWT guard — attach to any route that requires authentication
// ----------------------------------------------------------------
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

// ----------------------------------------------------------------
// Optional JWT guard — for routes that serve BOTH guests and members
//
// Public routes here are public by omission: they simply carry no guard,
// which means the handler has no way to tell a signed-in visitor from an
// anonymous one. That is fine when the response is identical either way,
// and useless the moment it isn't — a guest and a subscriber must see
// different versions of an artist profile, and telemetry has to know
// which one it is recording.
//
// This guard fills that gap. It resolves the session when a valid cookie
// is present and attaches req.user, and it returns null rather than
// throwing when one isn't. It never rejects: on a route that welcomes
// guests, a missing, expired, malformed or suspended-account token all
// mean the same thing — treat this caller as a guest — so handlers must
// branch on whether req.user exists, not assume it does.
// ----------------------------------------------------------------
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser>(_err: unknown, user: TUser | false): TUser | null {
    // Deliberately swallows _err. Passport reports "no token" and "bad
    // token" through the same channel it uses for real failures, and on a
    // guest-friendly route neither is an error worth a 401.
    return user || null;
  }
}

// ----------------------------------------------------------------
// Local guard — used only on POST /auth/login
// ----------------------------------------------------------------
@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {}

// ----------------------------------------------------------------
// Roles guard — use after JwtAuthGuard
// @Roles('admin') on a controller/handler restricts to that role
// ----------------------------------------------------------------
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!required.includes(user?.role)) {
      throw new ForbiddenException('You do not have permission to access this resource.');
    }
    return true;
  }
}
