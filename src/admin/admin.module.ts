import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ReviewsModule } from '../reviews/reviews.module';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports:     [ReviewsModule, AnalyticsModule],
  controllers: [AdminController],
  providers:   [AdminService],
})
export class AdminModule {}
