import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ArtistsService } from './artists.service';
import { SearchArtistsDto, UpdateArtistProfileDto } from './dto/artists.dto';
import { JwtAuthGuard, RolesGuard } from '../auth/guards/auth.guards';
import { CurrentUser, Roles } from '../auth/decorators/auth.decorators';

@Controller()
export class ArtistsController {
  constructor(private readonly artistsService: ArtistsService) {}

  // GET /categories
  @Get('categories')
  getCategories() {
    return this.artistsService.getCategories();
  }

  // GET /artists?q=&categories=&country=&city=&minPrice=&maxPrice=&verifiedOnly=&availableOn=&sort=&page=&limit=
  @Get('artists')
  search(@Query() dto: SearchArtistsDto) {
    return this.artistsService.search(dto);
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

  // GET /artists/:id
  @Get('artists/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.artistsService.findOne(id);
  }
}
