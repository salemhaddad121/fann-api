import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ArtistsService } from './artists.service';
import { SearchArtistsDto, UpdateArtistProfileDto } from './dto/artists.dto';
import { JwtAuthGuard, OptionalJwtAuthGuard, RolesGuard } from '../auth/guards/auth.guards';
import { CurrentUser, Public, Roles } from '../auth/decorators/auth.decorators';
import { UserRecord } from '../users/users.types';

@Controller()
export class ArtistsController {
  constructor(private readonly artistsService: ArtistsService) {}

  // GET /categories
  @Public()
  @Get('categories')
  getCategories() {
    return this.artistsService.getCategories();
  }

  // GET /artists?q=&categories=&country=&city=&minPrice=&maxPrice=&verifiedOnly=&availableOn=&sort=&page=&limit=
  //
  // OptionalJwtAuthGuard, not JwtAuthGuard: this route stays open to guests
  // and always has. The guard is here so the service can tell a guest from a
  // subscriber and shape the response accordingly — without it every caller
  // looks anonymous and everyone would get masked results.
  @Public()
  @Get('artists')
  @UseGuards(OptionalJwtAuthGuard)
  search(
    @Query() dto: SearchArtistsDto,
    @CurrentUser() viewer?: UserRecord,
    @Headers('x-session-id') sessionId?: string,
  ) {
    return this.artistsService.search(dto, {
      userId: viewer?.id,
      role: viewer?.role,
      sessionId,
    });
  }

  // GET /artists/me  — must come before /:id to avoid UUID parse on "me"
  @Get('artists/me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('artist')
  getMe(@CurrentUser('id') userId: string) {
    return this.artistsService.findMe(userId);
  }

  // PUT /artists/me
  @Put('artists/me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('artist')
  updateMe(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateArtistProfileDto,
  ) {
    return this.artistsService.updateMe(userId, dto);
  }

  // GET /artists/me/booker-types — this artist's bookings grouped by booker type
  @Get('artists/me/booker-types')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('artist')
  getBookerTypes(@CurrentUser('id') userId: string) {
    return this.artistsService.getBookerTypeBreakdown(userId);
  }

  // GET /artists/:id
  @Public()
  @Get('artists/:id')
  @UseGuards(OptionalJwtAuthGuard)
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() viewer?: UserRecord,
  ) {
    return this.artistsService.findOne(id, { userId: viewer?.id, role: viewer?.role });
  }
}
