import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { ListNotificationsDto } from './dto/notifications.dto';
import { JwtAuthGuard } from '../auth/guards/auth.guards';
import { CurrentUser } from '../auth/decorators/auth.decorators';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // GET /notifications?page=&limit=&unreadOnly=
  @Get()
  list(
    @CurrentUser('id') userId: string,
    @Query() dto: ListNotificationsDto,
  ) {
    return this.notificationsService.list(userId, dto);
  }

  // GET /notifications/unread-count — for a badge indicator
  @Get('unread-count')
  getUnreadCount(@CurrentUser('id') userId: string) {
    return this.notificationsService.getUnreadCount(userId);
  }

  // PATCH /notifications/read-all
  // Registered before /:id/read so "read-all" isn't parsed as a UUID.
  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@CurrentUser('id') userId: string) {
    return this.notificationsService.markAllRead(userId);
  }

  // PATCH /notifications/:id/read
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) notificationId: string,
  ) {
    return this.notificationsService.markRead(userId, notificationId);
  }
}
