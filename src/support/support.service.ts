import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import {
  CreateSupportTicketDto,
  ListSupportTicketsDto,
  UpdateSupportTicketDto,
} from './dto/support.dto';
import { aggregateValue } from '../common/db.util';

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    @InjectConnection() private readonly db: Knex,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Where new-ticket notifications go.
   *
   * ⚠️ Deliberately no longer falls back to EMAIL_FROM. That made sense
   * while both were the same address, but outbound mail now sends as
   * noreply@fann-leb.com — so inheriting it would quietly deliver every
   * support ticket to a mailbox named noreply, which is precisely where
   * nobody looks. The fallback is the human inbox instead.
   *
   * `||` rather than `??` on purpose: an env var present but set to an
   * empty string is the likely misconfiguration here, and `??` would pass
   * the empty string straight through as a recipient.
   */
  private get supportInbox(): string {
    return this.configService.get<string>('SUPPORT_INBOX_EMAIL')?.trim() || 'admin@fann-leb.com';
  }

  async create(
    viewer: { userId?: string; email?: string },
    dto: CreateSupportTicketDto,
  ) {
    const isGuest = !viewer.userId;

    // A guest with no address is a ticket nobody can answer. The database
    // CHECK enforces this too; catching it here is what turns a constraint
    // violation into a sentence the person can act on.
    if (isGuest && !dto.guestEmail) {
      throw new BadRequestException(
        'An email address is required so we can reply to you.',
      );
    }

    const [ticket] = await this.db('support_tickets')
      .insert({
        user_id: viewer.userId ?? null,
        // Taken from the account for signed-in users, so a ticket cannot be
        // filed under someone else's address by editing the request body.
        guest_email: isGuest ? dto.guestEmail : null,
        guest_name: isGuest ? (dto.guestName ?? null) : null,
        subject: dto.subject,
        body: dto.body,
        source_path: dto.sourcePath ?? null,
      })
      .returning(['id', 'subject', 'status', 'created_at']);

    // The opening message is stored in the thread as well as on the ticket,
    // so a reply thread reads in order from the beginning rather than
    // starting mid-conversation.
    await this.db('support_ticket_messages').insert({
      ticket_id: ticket.id,
      author_id: viewer.userId ?? null,
      is_staff: false,
      body: dto.body,
    });

    await this.notifyInbox(ticket.id, dto, viewer.email ?? dto.guestEmail);

    return {
      ...ticket,
      message:
        "Thanks — we've got your message and will reply by email.",
    };
  }

  /**
   * Emails the support inbox. Never throws.
   *
   * EmailService already swallows delivery failures, but the address lookup
   * and template can fail too, and a ticket that was successfully saved
   * must not report failure because the notification did not go out. The
   * row is the source of truth; the email is a convenience.
   */
  private async notifyInbox(
    ticketId: string,
    dto: CreateSupportTicketDto,
    replyTo?: string,
  ): Promise<void> {
    // No "not configured" branch any more: supportInbox always resolves to
    // a real address, so the old warning could never fire.
    const inbox = this.supportInbox;

    try {
      await this.emailService.sendSupportTicketEmail({
        to: inbox,
        ticketId,
        subject: dto.subject,
        body: dto.body,
        fromAddress: replyTo ?? 'unknown',
        sourcePath: dto.sourcePath,
      });
    } catch (err) {
      this.logger.error(`[Support] Failed to notify inbox for ${ticketId}`, err);
    }
  }

  /** A signed-in user's own tickets, newest first, with their threads. */
  async listMine(userId: string) {
    const tickets = await this.db('support_tickets')
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .select('id', 'subject', 'body', 'status', 'source_path', 'created_at', 'resolved_at');

    if (tickets.length === 0) return [];

    const messages = await this.db('support_ticket_messages')
      .whereIn(
        'ticket_id',
        tickets.map((t) => t.id),
      )
      .orderBy('created_at', 'asc')
      .select('id', 'ticket_id', 'is_staff', 'body', 'created_at');

    return tickets.map((ticket) => ({
      ...ticket,
      messages: messages.filter((m) => m.ticket_id === ticket.id),
    }));
  }

  // ================================================================
  // Admin
  // ================================================================

  async list(dto: ListSupportTicketsDto & { page?: number; limit?: number }) {
    const { page = 1, limit = 30 } = dto;
    const offset = (page - 1) * limit;

    const query = this.db('support_tickets as t')
      .leftJoin('users as u', 'u.id', 't.user_id')
      .leftJoin('users as a', 'a.id', 't.assigned_to')
      .select(
        't.id',
        't.subject',
        't.body',
        't.status',
        't.source_path',
        't.created_at',
        't.resolved_at',
        't.guest_email',
        't.guest_name',
        'u.email as user_email',
        'u.role as user_role',
        'a.email as assigned_email',
      )
      // Oldest first: a support queue is worked front to back, and newest
      // first quietly buries whatever has been waiting longest.
      .orderBy('t.created_at', 'asc');

    if (dto.status) query.where('t.status', dto.status);

    const [countRow, rows] = await Promise.all([
      query.clone().clearSelect().clearOrder().count('t.id as total').first(),
      query.limit(limit).offset(offset),
    ]);
    const total = aggregateValue(countRow, 'total');

    return {
      data: rows,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    };
  }

  async getOne(ticketId: string) {
    const ticket = await this.db('support_tickets as t')
      .leftJoin('users as u', 'u.id', 't.user_id')
      .where('t.id', ticketId)
      .select('t.*', 'u.email as user_email', 'u.role as user_role')
      .first();

    if (!ticket) throw new NotFoundException('Ticket not found.');

    const messages = await this.db('support_ticket_messages as m')
      .leftJoin('users as u', 'u.id', 'm.author_id')
      .where('m.ticket_id', ticketId)
      .orderBy('m.created_at', 'asc')
      .select('m.id', 'm.is_staff', 'm.body', 'm.created_at', 'u.email as author_email');

    return { ...ticket, messages };
  }

  async update(adminId: string, ticketId: string, dto: UpdateSupportTicketDto) {
    const ticket = await this.db('support_tickets').where({ id: ticketId }).first();
    if (!ticket) throw new NotFoundException('Ticket not found.');

    const patch: Record<string, unknown> = { updated_at: this.db.fn.now() };

    if (dto.status !== undefined) {
      patch.status = dto.status;
      // Stamped when it first reaches a terminal state and left alone
      // after, so reopening and re-resolving does not rewrite the original
      // resolution time.
      patch.resolved_at =
        dto.status === 'resolved' || dto.status === 'closed'
          ? (ticket.resolved_at ?? this.db.fn.now())
          : null;
    }

    if (dto.assignedTo !== undefined) patch.assigned_to = dto.assignedTo;

    await this.db('support_tickets').where({ id: ticketId }).update(patch);

    if (dto.reply) {
      await this.db('support_ticket_messages').insert({
        ticket_id: ticketId,
        author_id: adminId,
        is_staff: true,
        body: dto.reply,
      });

      await this.notifyRequester(ticket, dto.reply);
    }

    return this.getOne(ticketId);
  }

  /** Emails whoever raised the ticket that staff replied. Never throws. */
  private async notifyRequester(
    ticket: { id: string; user_id: string | null; guest_email: string | null; subject: string },
    reply: string,
  ): Promise<void> {
    try {
      let to = ticket.guest_email;
      if (ticket.user_id) {
        const user = await this.db('users')
          .where({ id: ticket.user_id })
          .select('email')
          .first();
        to = user?.email ?? null;
      }
      if (!to) return;

      await this.emailService.sendSupportReplyEmail({
        to,
        subject: ticket.subject,
        reply,
      });
    } catch (err) {
      this.logger.error(`[Support] Failed to notify requester for ${ticket.id}`, err);
    }
  }
}
