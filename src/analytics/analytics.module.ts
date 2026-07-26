import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  // AdminModule reads the engagement aggregate for the admin dashboard.
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
