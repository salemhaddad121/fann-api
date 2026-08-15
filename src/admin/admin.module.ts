import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ReviewsModule } from '../reviews/reviews.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { VerificationModule } from '../verification/verification.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SupportModule } from '../support/support.module';

@Module({
  imports:     [ReviewsModule, AnalyticsModule, VerificationModule, SubscriptionsModule, SupportModule],
  controllers: [AdminController],
  providers:   [AdminService],
})
export class AdminModule {}
