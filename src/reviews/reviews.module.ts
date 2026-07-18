import { Module } from '@nestjs/common';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

@Module({
  controllers: [ReviewsController],
  providers:   [ReviewsService],
  exports:     [ReviewsService],  // exported so SchedulerService and AdminService can use it
})
export class ReviewsModule {}
