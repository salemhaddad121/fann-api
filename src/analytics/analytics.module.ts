import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsExportService } from './analytics-export.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsExportService],
  // AdminModule reads the engagement aggregate for the admin dashboard, and
  // ArtistsModule records a search event from the search handler.
  exports: [AnalyticsService, AnalyticsExportService],
})
export class AnalyticsModule {}
