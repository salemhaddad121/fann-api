import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { CreatePaymentIntentDto, ReportTransferDto } from './dto/subscriptions.dto';
import { JwtAuthGuard, RolesGuard } from '../auth/guards/auth.guards';
import { CurrentUser, Roles } from '../auth/decorators/auth.decorators';

@Controller()
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  // GET /subscriptions/plans
  //
  // Deliberately unguarded. The pricing page is the main thing a guest is
  // sent to from a locked profile, so it has to render before sign-in.
  @Get('subscriptions/plans')
  listPlans() {
    return this.subscriptionsService.listPlans();
  }

  // GET /subscriptions/me
  //
  // Any signed-in role. Artists simply get empty lists — returning 403
  // would make the shared dashboard banner branch on role for no reason.
  @Get('subscriptions/me')
  @UseGuards(JwtAuthGuard)
  getMine(@CurrentUser('id') userId: string) {
    return this.subscriptionsService.getMine(userId);
  }

  // POST /subscriptions/:id/activate — start the clock on a day-pass credit
  @Post('subscriptions/:id/activate')
  @UseGuards(JwtAuthGuard)
  activate(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) subscriptionId: string,
  ) {
    return this.subscriptionsService.activate(userId, subscriptionId);
  }

  // POST /payments — create a purchase intent
  @Post('payments')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('planner')
  createPayment(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePaymentIntentDto,
  ) {
    return this.subscriptionsService.createPaymentIntent(userId, dto);
  }

  // GET /payments/me
  @Get('payments/me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('planner')
  listMyPayments(@CurrentUser('id') userId: string) {
    return this.subscriptionsService.listMyPayments(userId);
  }

  // GET /payments/:id — polled by the return page after a redirect.
  //
  // Declared after /payments/me so "me" is not swallowed by :id. Nest
  // matches in declaration order, and ParseUUIDPipe would reject it with a
  // 400 rather than falling through.
  @Get('payments/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('planner')
  getPayment(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) paymentId: string,
  ) {
    return this.subscriptionsService.getMyPayment(userId, paymentId);
  }

  // PATCH /payments/:id/transfer — report the transfer reference
  @Patch('payments/:id/transfer')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('planner')
  reportTransfer(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Body() dto: ReportTransferDto,
  ) {
    return this.subscriptionsService.reportTransfer(userId, paymentId, dto);
  }
}
