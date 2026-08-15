import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SupportService } from './support.service';
import { CreateSupportTicketDto } from './dto/support.dto';
import { JwtAuthGuard, OptionalJwtAuthGuard } from '../auth/guards/auth.guards';
import { CurrentUser } from '../auth/decorators/auth.decorators';
import { UserRecord } from '../users/users.types';

@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  // POST /support/tickets
  //
  // Guests allowed — the people most likely to need help are the ones who
  // cannot get in, and a contact form behind a login wall is no use to
  // someone who cannot log in.
  //
  // Throttled tighter than the global default. This is an unauthenticated
  // endpoint that sends an email on every call, so it is the obvious thing
  // to point a script at.
  @Post('tickets')
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  create(@CurrentUser() viewer: UserRecord | undefined, @Body() dto: CreateSupportTicketDto) {
    return this.supportService.create(
      { userId: viewer?.id, email: viewer?.email },
      dto,
    );
  }

  // GET /support/tickets/me
  @Get('tickets/me')
  @UseGuards(JwtAuthGuard)
  listMine(@CurrentUser('id') userId: string) {
    return this.supportService.listMine(userId);
  }
}
