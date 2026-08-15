import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { CreateAvailabilityBlockDto } from './dto/availability.dto';
import { JwtAuthGuard, RolesGuard } from '../auth/guards/auth.guards';
import { CurrentUser, Public, Roles } from '../auth/decorators/auth.decorators';

@Controller()
export class AvailabilityController {
  constructor(private readonly availabilityService: AvailabilityService) {}

  // GET /artists/:userId/availability  — public, no auth required
  @Public()
  @Get('artists/:userId/availability')
  getByArtist(@Param('userId', ParseUUIDPipe) artistUserId: string) {
    return this.availabilityService.getByArtistUserId(artistUserId);
  }

  // POST /artists/me/availability
  @Post('artists/me/availability')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('artist')
  create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateAvailabilityBlockDto,
  ) {
    return this.availabilityService.create(userId, dto);
  }

  // DELETE /artists/me/availability/:id
  @Delete('artists/me/availability/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('artist')
  remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) blockId: string,
  ) {
    return this.availabilityService.remove(userId, blockId);
  }
}
