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
  // Public — no guard, mirrors GET /artists in artists.controller.ts.
  @Public()
  @Get()
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
  @Public()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.plannersService.findOne(id);
  }
}
