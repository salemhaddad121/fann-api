import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AnalyticsService } from './analytics.service';
import { RecordPageEventsDto } from './dto/analytics.dto';
import { OptionalJwtAuthGuard } from '../auth/guards/auth.guards';
import { CurrentUser, Public } from '../auth/decorators/auth.decorators';
import { UserRecord } from '../users/users.types';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // POST /analytics/page-views
  //
  // Open to guests. This was authenticated-only because role was the entire
  // point of the data, but guests are now the audience most worth
  // understanding — they are the ones deciding whether to sign up — and an
  // anonymous row carrying a session id is far from unusable: it is what
  // makes guest session duration computable at all.
  //
  // OptionalJwtAuthGuard rather than no guard: a signed-in visitor must
  // still be recorded with their real user_id and role, and only a resolved
  // session can supply those.
  //
  // The global throttler is 10 requests/60s, which is fine for batched
  // flushes but tight if someone navigates rapidly and each flush fires.
  // Raised to 30/60s here: still a hard ceiling on write volume from one
  // client, but it will not drop legitimate telemetry from an active user.
  @Public()
  @Post('page-views')
  @UseGuards(ThrottlerGuard, OptionalJwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async recordPageViews(
    @CurrentUser() viewer: UserRecord | undefined,
    @Body() dto: RecordPageEventsDto,
  ) {
    await this.analyticsService.recordPageEvents(
      { userId: viewer?.id, role: viewer?.role },
      dto,
    );
  }
}
