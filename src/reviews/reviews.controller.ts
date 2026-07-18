import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ReviewsService } from './reviews.service';
import { SubmitReviewDto } from './dto/reviews.dto';
import { JwtAuthGuard } from '../auth/guards/auth.guards';
import { CurrentUser } from '../auth/decorators/auth.decorators';
import { UserRecord } from '../users/users.types';

@Controller()
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  // POST /reviews — submit a review for a completed booking
  @Post('reviews')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  submit(
    @CurrentUser() user: UserRecord,
    @Body() dto: SubmitReviewDto,
  ) {
    return this.reviewsService.submit(user, dto);
  }

  // GET /artists/:id/reviews — visible reviews for an artist (public)
  @Get('artists/:id/reviews')
  getForArtist(@Param('id', ParseUUIDPipe) artistUserId: string) {
    return this.reviewsService.getForArtist(artistUserId);
  }

  // GET /planners/:id/reviews — visible reviews for a planner (public)
  @Get('planners/:id/reviews')
  getForPlanner(@Param('id', ParseUUIDPipe) plannerUserId: string) {
    return this.reviewsService.getForPlanner(plannerUserId);
  }
}
