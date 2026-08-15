import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { UserRecord } from '../../users/users.types';

export const ROLES_KEY = 'roles';
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * @Public() — allow this route without a session.
 *
 * The API is default-deny: JwtAuthGuard is registered globally (see
 * app.module.ts), so every route requires authentication unless it is
 * marked with this. That direction matters — a route added next month is
 * private until someone deliberately opens it, rather than public until
 * someone remembers to guard it.
 *
 * Routes that serve BOTH guests and members still need this, and then add
 * OptionalJwtAuthGuard themselves: @Public() lets the request past the
 * global guard, and the optional guard resolves the session if a cookie
 * happens to be present.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);


/**
 * @Roles('admin') — restrict a route to one or more roles.
 * Must be used together with RolesGuard after JwtAuthGuard.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * @CurrentUser() — injects the authenticated user into a handler parameter.
 * Optionally pass a key to extract a single field: @CurrentUser('id')
 */
export const CurrentUser = createParamDecorator(
  (key: keyof UserRecord | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user: UserRecord = request.user;
    return key ? user?.[key] : user;
  },
);
