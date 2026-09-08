import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { hasActiveSubscription } from './subscription.util';
import { UserRole } from '../users/users.types';

export const SUBSCRIPTION_ROLES_KEY = 'subscriptionRoles';

/**
 * @RequiresSubscription('planner') — narrows the guard to the roles that
 * actually buy Paid Access.
 *
 * Needed because the routes worth gating are not single-role. POST
 * /conversations serves a planner opening a thread with an artist AND an
 * artist sending a message request to a planner; the first is the thing
 * Paid Access sells, the second is an artist using their own inbox. A bare
 * guard on that route would bill artists for answering their own mail.
 *
 * Listing no roles means everyone who reaches the route needs a plan, which
 * is the right default for a route that only paying users have any business
 * calling.
 */
export const RequiresSubscription = (...roles: UserRole[]) =>
  SetMetadata(SUBSCRIPTION_ROLES_KEY, roles);

/**
 * Blocks a route unless the caller has a live subscription.
 *
 * Use it AFTER JwtAuthGuard: this guard answers "have they paid?", not
 * "who are they?", and it deliberately does not try to resolve a session
 * itself.
 *
 * The refusal is 402 Payment Required, not 403. The distinction matters to
 * the frontend, which has to tell two situations apart that 403 would blur
 * together: this account is not allowed to do this (403 — show an error),
 * and this account just needs to buy a plan (402 — show the upgrade CTA).
 * 402 is an unusual status to reach for, but it is the one that means what
 * is actually happening here.
 */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    @InjectConnection() private readonly db: Knex,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest();

    // No session at all means the route was wired without an auth guard in
    // front of this one. Fail loudly rather than reporting it as a missing
    // subscription, which would send the caller off to buy a plan they may
    // already have.
    if (!user?.id) {
      throw new UnauthorizedException('You must be signed in to access this resource.');
    }

    // getAllAndOverride so the scope can be declared once on a controller
    // and still be narrowed on a single handler.
    const scoped = this.reflector.getAllAndOverride<UserRole[]>(SUBSCRIPTION_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // A role outside the declared scope is not an unpaid customer, it is
    // someone this route was never sold to. Let it through and leave the
    // handler's own rules to decide what it may do.
    if (scoped?.length && !scoped.includes(user.role)) {
      return true;
    }

    if (!(await hasActiveSubscription(this.db, user.id))) {
      throw new HttpException(
        'This requires an active subscription.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
