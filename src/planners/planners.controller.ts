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
import { PlannersService } from './planners.service';
import { SearchPlannersDto, UpdatePlannerProfileDto } from './dto/planners.dto';
import { JwtAuthGuard, RolesGuard } from '../auth/guards/auth.guards';
import { CurrentUser, Public, Roles } from '../auth/decorators/auth.decorators';

@Controller('planners')
export class PlannersController {
  constructor(private readonly plannersService: PlannersService) {}

  // GET /planners?q=&eventTypes=&country=&city=&sort=&page=&limit=
  //
  // Artists and admins only. This carried @Public() with the comment
  // "mirrors GET /artists" — and that mirroring was the bug. An artist
  // roster is a shop window and belongs in public; a booker list is a
  // customer list and does not. Anyone with a browser and no account could
  // page through every booker on Fann: display name, company name, bio,
  // city and social links.
  //
  // That was survivable while every booker was a business. The $5 day pass
  // means the list now fills with private individuals, which makes it a
  // data-protection exposure under Lebanese Law No. 81/2018 rather than a
  // product wrinkle.
  //
  // Bookers are excluded too, not just guests: one booker has no reason to
  // browse another, and "customers can read the customer list" is the same
  // problem with a login in front of it.
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('artist', 'admin')
  search(@Query() dto: SearchPlannersDto) {
    return this.plannersService.search(dto);
  }

  // GET /planners/me
  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('planner')
  getMe(@CurrentUser('id') userId: string) {
    return this.plannersService.findMe(userId);
  }

  // PUT /planners/me
  @Put('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('planner')
  updateMe(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdatePlannerProfileDto,
  ) {
    return this.plannersService.updateMe(userId, dto);
  }

  // GET /planners/event-types — public. Registered before the :id route
  // below, or Express would match "event-types" as the :id param instead
  // (same reason /planners/me is registered before /planners/:id).
  @Public()
  @Get('event-types')
  getEventTypes() {
    return this.plannersService.getEventTypes();
  }

  // GET /planners/:id
  //
  // Same audience as the list above, and the kind check lives in the
  // service rather than here: without it an artist who kept or guessed a
  // planner UUID could read an individual's profile directly, which is the
  // list leak again through a different door.
  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('artist', 'admin')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.plannersService.findOne(id);
  }
}
