import { Module } from '@nestjs/common';
import { ArtistsController } from './artists.controller';
import { ArtistsService } from './artists.service';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  // Search records its own telemetry, so the count cannot be inflated by a
  // client reporting it.
  imports:     [AnalyticsModule],
  controllers: [ArtistsController],
  providers:   [ArtistsService],
  exports:     [ArtistsService],
})
export class ArtistsModule {}
