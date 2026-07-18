import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { SavedService } from './saved.service';
import { JwtAuthGuard, RolesGuard } from '../auth/guards/auth.guards';
import { CurrentUser, Roles } from '../auth/decorators/auth.decorators';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('planner')
export class SavedController {
  constructor(private readonly savedService: SavedService) {}

  // GET /saved-artists
  @Get('saved-artists')
  listMine(@CurrentUser('id') plannerId: string) {
    return this.savedService.listMine(plannerId);
  }

  // GET /saved-artists/ids — lightweight, for showing filled hearts in search results
  @Get('saved-artists/ids')
  listMineIds(@CurrentUser('id') plannerId: string) {
    return this.savedService.listMySavedIds(plannerId);
  }

  // POST /saved-artists/:artistProfileId
  @Post('saved-artists/:artistProfileId')
  save(
    @CurrentUser('id') plannerId: string,
    @Param('artistProfileId', ParseUUIDPipe) artistProfileId: string,
  ) {
    return this.savedService.save(plannerId, artistProfileId);
  }

  // DELETE /saved-artists/:artistProfileId
  @Delete('saved-artists/:artistProfileId')
  unsave(
    @CurrentUser('id') plannerId: string,
    @Param('artistProfileId', ParseUUIDPipe) artistProfileId: string,
  ) {
    return this.savedService.unsave(plannerId, artistProfileId);
  }
}
