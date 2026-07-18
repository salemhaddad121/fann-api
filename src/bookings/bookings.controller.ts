import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { BookingsService } from './bookings.service';
import {
  CancelBookingDto,
  CreateBookingDto,
  RespondBookingDto,
} from './dto/bookings.dto';
import { JwtAuthGuard, RolesGuard } from '../auth/guards/auth.guards';
import { CurrentUser, Roles } from '../auth/decorators/auth.decorators';
import { UserRecord } from '../users/users.types';

@Controller('bookings')
@UseGuards(JwtAuthGuard)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  // GET /bookings/me — list own bookings
  @Get('me')
  listMine(@CurrentUser() user: UserRecord) {
    return this.bookingsService.listMine(user);
  }

  // GET /bookings/:id
  @Get(':id')
  findOne(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) bookingId: string,
  ) {
    return this.bookingsService.findOne(userId, bookingId);
  }

  // POST /bookings — planner proposes a booking
  @Post()
  @UseGuards(RolesGuard)
  @Roles('planner')
  create(
    @CurrentUser() user: UserRecord,
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookingsService.create(user, dto);
  }

  // PATCH /bookings/:id/respond — artist accepts or declines
  @Patch(':id/respond')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles('artist')
  respond(
    @CurrentUser() user: UserRecord,
    @Param('id', ParseUUIDPipe) bookingId: string,
    @Body() dto: RespondBookingDto,
  ) {
    return this.bookingsService.respond(user, bookingId, dto);
  }

  // PATCH /bookings/:id/cancel — either party cancels
  @Patch(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: UserRecord,
    @Param('id', ParseUUIDPipe) bookingId: string,
    @Body() dto: CancelBookingDto,
  ) {
    return this.bookingsService.cancel(user, bookingId, dto);
  }
}
