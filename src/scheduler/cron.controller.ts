import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { SchedulerService } from './scheduler.service';
import { Public } from '../auth/decorators/auth.decorators';

// HTTP triggers for the scheduled work.
//
// WHY THIS EXISTS: @nestjs/schedule's @Cron needs a process that stays
// alive. That is true in the Docker container, and false on Vercel, where
// each request is a short-lived function — the decorators would simply
// never fire and the review triggers and telemetry prune would silently
// stop running. Vercel Cron instead calls an HTTP path on a schedule (see
// vercel.json), so the same service methods are reachable both ways.
//
// SCHEDULER_MODE decides which trigger is live so the work never runs
// twice: 'in-process' (the default, and what the container uses) keeps the
// @Cron decorators active and refuses these endpoints; 'http' does the
// opposite.
//
// EACH ROUTE ANSWERS BOTH GET AND POST. Vercel Cron invokes with GET — this
// was POST-only until 2026-08-07, so every scheduled run since the project
// went live 404'd and none of the work below ever ran in production. Proven
// in the runtime logs:
//
//   07:00:40 GET /api/v1/cron/telemetry-prune 404
//
// which is exactly the `0 7 * * *` slot. POST is kept so the jobs can still
// be triggered by hand with curl.
@Controller('cron')
@Public()
export class CronController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly config: ConfigService,
  ) {}

  // Vercel attaches `Authorization: Bearer $CRON_SECRET` automatically when
  // that variable is set on the project. Compared in constant time so the
  // endpoint cannot be probed a byte at a time.
  private assertAuthorised(authorization?: string) {
    if (this.config.get<string>('SCHEDULER_MODE') !== 'http') {
      throw new ForbiddenException(
        'Scheduled work runs in-process here. Set SCHEDULER_MODE=http to drive it over HTTP.',
      );
    }

    const secret = this.config.get<string>('CRON_SECRET');
    if (!secret) {
      throw new ForbiddenException('CRON_SECRET is not configured.');
    }

    const provided = authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForbiddenException('Invalid cron secret.');
    }
  }

  // Stacking @Get and @Post on one handler does NOT register both — the
  // second decorator overwrites the first, and Nest maps only one verb. So
  // each job gets a thin handler per verb, both delegating to one
  // implementation.

  @Get('daily-review-trigger')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dailyReviewTriggerGet(@Headers('authorization') authorization?: string) {
    return this.dailyReviewTrigger(authorization);
  }

  @Post('daily-review-trigger')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dailyReviewTrigger(@Headers('authorization') authorization?: string) {
    this.assertAuthorised(authorization);
    await this.scheduler.runDailyReviewTrigger();
  }

  @Get('expired-review-unlock')
  @HttpCode(HttpStatus.NO_CONTENT)
  async expiredReviewUnlockGet(@Headers('authorization') authorization?: string) {
    return this.expiredReviewUnlock(authorization);
  }

  @Post('expired-review-unlock')
  @HttpCode(HttpStatus.NO_CONTENT)
  async expiredReviewUnlock(@Headers('authorization') authorization?: string) {
    this.assertAuthorised(authorization);
    await this.scheduler.runExpiredReviewUnlock();
  }

  @Get('telemetry-prune')
  @HttpCode(HttpStatus.NO_CONTENT)
  async telemetryPruneGet(@Headers('authorization') authorization?: string) {
    return this.telemetryPrune(authorization);
  }

  @Post('telemetry-prune')
  @HttpCode(HttpStatus.NO_CONTENT)
  async telemetryPrune(@Headers('authorization') authorization?: string) {
    this.assertAuthorised(authorization);
    await this.scheduler.runTelemetryPrune();
  }

  // Hourly under SCHEDULER_MODE=http — see vercel.json. Expiry and
  // promotion are the only jobs here that are not daily.
  @Get('subscription-maintenance')
  @HttpCode(HttpStatus.NO_CONTENT)
  async subscriptionMaintenanceGet(@Headers('authorization') authorization?: string) {
    return this.subscriptionMaintenance(authorization);
  }

  @Post('subscription-maintenance')
  @HttpCode(HttpStatus.NO_CONTENT)
  async subscriptionMaintenance(@Headers('authorization') authorization?: string) {
    this.assertAuthorised(authorization);
    await this.scheduler.runSubscriptionMaintenance();
  }

  @Get('renewal-reminders')
  @HttpCode(HttpStatus.NO_CONTENT)
  async renewalRemindersGet(@Headers('authorization') authorization?: string) {
    return this.renewalReminders(authorization);
  }

  @Post('renewal-reminders')
  @HttpCode(HttpStatus.NO_CONTENT)
  async renewalReminders(@Headers('authorization') authorization?: string) {
    this.assertAuthorised(authorization);
    await this.scheduler.runRenewalReminders();
  }
// Every 15 minutes under SCHEDULER_MODE=http.
  @Get('payment-reconciliation')
  @HttpCode(HttpStatus.NO_CONTENT)
  async paymentReconciliationGet(@Headers('authorization') authorization?: string) {
    return this.paymentReconciliation(authorization);
  }

  @Post('payment-reconciliation')
  @HttpCode(HttpStatus.NO_CONTENT)
  async paymentReconciliation(@Headers('authorization') authorization?: string) {
    this.assertAuthorised(authorization);
    await this.scheduler.runPaymentReconciliation();
  }
}