import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AnalyticsService } from './analytics.service';
import { RecordPageEventsDto } from './dto/analytics.dto';
import { JwtAuthGuard } from '../auth/guards/auth.guards';
import { CurrentUser } from '../auth/decorators/auth.decorators';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  // POST /analytics/page-views
  //
  // Authenticated only — role is the entire point of this data, and an
  // anonymous row would be unusable for the metrics it feeds.
  //
  // The global throttler is 10 requests/60s, which is fine for batched
  // flushes but tight if someone navigates rapidly and each flush fires.
  // Raised to 30/60s here: still a hard ceiling on write volume from one
  // client, but it will not drop legitimate telemetry from an active user.
  @Post('page-views')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async recordPageViews(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Body() dto: RecordPageEventsDto,
  ) {
    await this.analyticsService.recordPageEvents(userId, role, dto);
  }
}
