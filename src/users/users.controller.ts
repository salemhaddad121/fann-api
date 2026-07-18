import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // GET /users/:id/public-info — public, no guard. Deliberately minimal:
  // name, thumbnail, role, and the profile id needed to link to
  // /artists/[id] or /planners/[id]. No email/phone/status exposed.
  @Get(':id/public-info')
  getPublicInfo(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.getPublicInfo(id);
  }
}
