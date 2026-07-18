import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { ListNotificationsDto } from './dto/notifications.dto';

@Injectable()
export class NotificationsService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  // ----------------------------------------------------------------
  // List the current user's notifications, newest first
  // ----------------------------------------------------------------
  async list(userId: string, dto: ListNotificationsDto) {
    const page  = dto.page  ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    let query = this.db('notifications')
      .where({ user_id: userId })
      .select('id', 'type', 'title', 'body', 'data', 'read_at', 'created_at');

    if (dto.unreadOnly) {
      query = query.whereNull('read_at');
    }

    const [{ total }, rows] = await Promise.all([
      query.clone().clearSelect().clearOrder().count('id as total').first(),
      query.orderBy('created_at', 'desc').limit(limit).offset(offset),
    ]);

    return {
      data: rows,
      meta: { total: Number(total), page, limit, pages: Math.ceil(Number(total) / limit) },
    };
  }

  // ----------------------------------------------------------------
  // Badge count — number of unread notifications
  // ----------------------------------------------------------------
  async getUnreadCount(userId: string) {
    const { count } = await this.db('notifications')
      .where({ user_id: userId })
      .whereNull('read_at')
      .count('id as count')
      .first();

    return { unreadCount: Number(count) };
  }

  // ----------------------------------------------------------------
  // Mark a single notification as read
  // ----------------------------------------------------------------
  async markRead(userId: string, notificationId: string) {
    const notification = await this.db('notifications').where({ id: notificationId }).first();
    if (!notification) throw new NotFoundException('Notification not found.');
    if (notification.user_id !== userId) {
      throw new ForbiddenException('You do not have permission to access this notification.');
    }

    if (!notification.read_at) {
      await this.db('notifications')
        .where({ id: notificationId })
        .update({ read_at: this.db.fn.now() });
    }

    return { message: 'Notification marked as read.' };
  }

  // ----------------------------------------------------------------
  // Mark every unread notification as read
  // ----------------------------------------------------------------
  async markAllRead(userId: string) {
    const affected = await this.db('notifications')
      .where({ user_id: userId })
      .whereNull('read_at')
      .update({ read_at: this.db.fn.now() });

    return { message: `${affected} notification(s) marked as read.` };
  }
}
