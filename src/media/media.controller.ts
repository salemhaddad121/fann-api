import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { MediaService } from './media.service';
import { ConfirmMediaDto, PresignMediaDto } from './dto/media.dto';
import { JwtAuthGuard } from '../auth/guards/auth.guards';
import { CurrentUser } from '../auth/decorators/auth.decorators';

@Controller('media')
@UseGuards(JwtAuthGuard)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  // POST /media/presign
  // Returns a presigned S3 PUT URL. Client uploads directly; no data passes through the API.
  @Post('presign')
  presign(
    @CurrentUser('id') userId: string,
    @Body() dto: PresignMediaDto,
  ) {
    return this.mediaService.presign(userId, dto);
  }

  // POST /media/confirm
  // After the client finishes uploading, call this to register the DB row.
  @Post('confirm')
  confirm(
    @CurrentUser('id') userId: string,
    @Body() dto: ConfirmMediaDto,
  ) {
    return this.mediaService.confirm(userId, dto);
  }

  // PUT /media/:id/primary
  @Put(':id/primary')
  setPrimary(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) mediaId: string,
  ) {
    return this.mediaService.setPrimary(userId, mediaId);
  }

  // DELETE /media/:id
  @Delete(':id')
  remove(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) mediaId: string,
  ) {
    return this.mediaService.remove(userId, mediaId);
  }
}
