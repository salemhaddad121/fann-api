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
