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
import { CurrentUser, Roles } from '../auth/decorators/auth.decorators';

@Controller('planners')
export class PlannersController {
  constructor(private readonly plannersService: PlannersService) {}

  // GET /planners?q=&eventTypes=&country=&city=&sort=&page=&limit=
  // Public — no guard, mirrors GET /artists in artists.controller.ts.
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

  // GET /planners/:id
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.plannersService.findOne(id);
  }
}
