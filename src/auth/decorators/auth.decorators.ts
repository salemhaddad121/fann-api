import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { UserRecord } from '../../users/users.types';

export const ROLES_KEY = 'roles';

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
