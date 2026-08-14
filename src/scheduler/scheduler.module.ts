import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { CronController } from './cron.controller';
import { BookingsModule } from '../bookings/bookings.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BookingsModule,
    ReviewsModule,
    AnalyticsModule,
    SubscriptionsModule,
  ],
  controllers: [CronController],
  providers: [SchedulerService],
})
export class SchedulerModule {}
