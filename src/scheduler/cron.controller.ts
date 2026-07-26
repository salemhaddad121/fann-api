import {
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { SchedulerService } from './scheduler.service';

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
@Controller('cron')
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

  @Post('daily-review-trigger')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dailyReviewTrigger(@Headers('authorization') authorization?: string) {
    this.assertAuthorised(authorization);
    await this.scheduler.runDailyReviewTrigger();
  }

  @Post('expired-review-unlock')
  @HttpCode(HttpStatus.NO_CONTENT)
  async expiredReviewUnlock(@Headers('authorization') authorization?: string) {
    this.assertAuthorised(authorization);
    await this.scheduler.runExpiredReviewUnlock();
  }

  @Post('telemetry-prune')
  @HttpCode(HttpStatus.NO_CONTENT)
  async telemetryPrune(@Headers('authorization') authorization?: string) {
    this.assertAuthorised(authorization);
    await this.scheduler.runTelemetryPrune();
  }
}
