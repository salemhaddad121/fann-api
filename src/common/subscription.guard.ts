import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { hasActiveSubscription } from './subscription.util';

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
  constructor(@InjectConnection() private readonly db: Knex) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest();

    // No session at all means the route was wired without an auth guard in
    // front of this one. Fail loudly rather than reporting it as a missing
    // subscription, which would send the caller off to buy a plan they may
    // already have.
    if (!user?.id) {
      throw new UnauthorizedException('You must be signed in to access this resource.');
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
