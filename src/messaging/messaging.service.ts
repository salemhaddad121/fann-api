import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { aggregateValue } from '../common/db.util';
import {
  CreateConversationDto,
  GetMessagesDto,
  SendMessageDto,
} from './dto/messaging.dto';
import { UserRecord } from '../users/users.types';

@Injectable()
export class MessagingService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  // ----------------------------------------------------------------
  // List conversations for the authenticated user
  // Returns threads with the other party's display name, thumbnail,
  // the last message body, and the unread count for this user.
  // ----------------------------------------------------------------
  async listConversations(user: UserRecord) {
    // Build the raw query differently depending on role:
    // artists see conversations where they are the artist,
    // planners see conversations where they are the planner.
    const isArtist = user.role === 'artist';

    const rows = await this.db('conversations as c')
      // Join the "other" party's profile
      .join(
        isArtist ? 'planner_profiles as op' : 'artist_profiles as op',
        isArtist ? 'op.user_id' : 'op.user_id',
        isArtist ? 'c.planner_id' : 'c.artist_id',
      )
      // Last message
      .leftJoin(
        this.db('messages')
          .select('conversation_id')
          .max('created_at as latest_at')
          .groupBy('conversation_id')
          .as('lm_time'),
        'lm_time.conversation_id', 'c.id',
      )
      .leftJoin(
        'messages as lm',
        (join) =>
          join
            .on('lm.conversation_id', 'c.id')
            .on('lm.created_at', 'lm_time.latest_at'),
      )
      .where(isArtist ? 'c.artist_id' : 'c.planner_id', user.id)
      // Declined requests are dead threads — kept as rows so the artist
      // can't re-request, but shown to neither side.
      .whereNot('c.status', 'declined')
      .select(
        'c.id',
        'c.artist_id',
        'c.planner_id',
        'c.last_message_at',
        'c.created_at',
        'c.status',
        'c.initiated_by',
        'op.display_name as other_display_name',
        'op.thumbnail_url as other_thumbnail_url',
        'lm.body as last_message_body',
        'lm.sender_id as last_message_sender_id',
      )
      .orderBy('c.last_message_at', 'desc');

    // Attach unread counts per conversation in one query
    const conversationIds = rows.map((r) => r.id);
    const unreadCounts =
      conversationIds.length > 0
        ? await this.db('messages')
            .whereIn('conversation_id', conversationIds)
            .where('read_at', null)
            .whereNot('sender_id', user.id)
            .groupBy('conversation_id')
            .select('conversation_id')
            .count('id as unread')
        : [];

    const unreadMap = Object.fromEntries(
      unreadCounts.map((r) => [r.conversation_id, Number(r.unread)]),
    );

    return rows.map((r) => ({
      ...r,
      unreadCount: unreadMap[r.id] ?? 0,
    }));
  }

  // ----------------------------------------------------------------
  // Start a conversation
  //
  // Either side may initiate, but the directions aren't symmetric. A
  // planner opening a thread with an artist is the product's normal flow
  // and is accepted immediately. An artist opening one with a planner is
  // a *request* that stays pending until the planner accepts, so cold
  // artist -> planner outreach doesn't land straight in an inbox.
  //
  // Creates the row if it doesn't exist, otherwise returns the existing
  // one.
  // ----------------------------------------------------------------
  async createConversation(user: UserRecord, dto: CreateConversationDto) {
    if (user.role === 'planner') {
      return this.startAsPlanner(user, dto.artistId);
    }
    if (user.role === 'artist') {
      return this.startAsArtist(user, dto.plannerId);
    }
    throw new ForbiddenException('Only artists and planners can start conversations.');
  }

  private async startAsPlanner(planner: UserRecord, artistId?: string) {
    if (!artistId) {
      throw new BadRequestException('artistId is required to message an artist.');
    }

    const artist = await this.db('users')
      .where({ id: artistId, role: 'artist', status: 'active' })
      .first();

    if (!artist) throw new NotFoundException('Artist not found.');
    if (artist.id === planner.id) throw new BadRequestException('Cannot message yourself.');

    const existing = await this.db('conversations')
      .where({ artist_id: artistId, planner_id: planner.id })
      .first();

    if (existing) return existing;

    const [conversation] = await this.db('conversations')
      .insert({
        artist_id:    artistId,
        planner_id:   planner.id,
        initiated_by: planner.id,
        status:       'accepted',
      })
      .returning('*');

    return conversation;
  }

  private async startAsArtist(artist: UserRecord, plannerId?: string) {
    if (!plannerId) {
      throw new BadRequestException('plannerId is required to message a planner.');
    }

    const planner = await this.db('users')
      .where({ id: plannerId, role: 'planner', status: 'active' })
      .first();

    if (!planner) throw new NotFoundException('Planner not found.');
    if (planner.id === artist.id) throw new BadRequestException('Cannot message yourself.');

    const existing = await this.db('conversations')
      .where({ artist_id: artist.id, planner_id: plannerId })
      .first();

    // A declined request is terminal — surfacing it as "already exists"
    // would let an artist retry in a loop.
    if (existing) {
      if (existing.status === 'declined') {
        throw new ForbiddenException('This planner declined your message request.');
      }
      return existing;
    }

    const [conversation] = await this.db('conversations')
      .insert({
        artist_id:    artist.id,
        planner_id:   plannerId,
        initiated_by: artist.id,
        status:       'pending',
      })
      .returning('*');

    const artistProfile = await this.db('artist_profiles')
      .where({ user_id: artist.id })
      .select('display_name')
      .first();

    await this.db('notifications').insert({
      user_id: plannerId,
      type:    'message_request',
      title:   `${artistProfile?.display_name ?? 'An artist'} wants to message you`,
      data:    JSON.stringify({
        conversation_id: conversation.id,
        artist_name:     artistProfile?.display_name ?? null,
      }),
    });

    return conversation;
  }

  // ----------------------------------------------------------------
  // Planner accepts or declines an artist's message request
  // ----------------------------------------------------------------
  async respondToRequest(
    planner: UserRecord,
    conversationId: string,
    decision: 'accepted' | 'declined',
  ) {
    const conversation = await this.assertParticipant(planner.id, conversationId);

    if (conversation.planner_id !== planner.id) {
      throw new ForbiddenException('Only the planner can respond to a message request.');
    }
    if (conversation.status !== 'pending') {
      throw new BadRequestException(`This request is already ${conversation.status}.`);
    }

    const [updated] = await this.db('conversations')
      .where({ id: conversationId })
      .update({ status: decision })
      .returning('*');

    if (decision === 'accepted') {
      const plannerProfile = await this.db('planner_profiles')
        .where({ user_id: planner.id })
        .select('display_name')
        .first();

      await this.db('notifications').insert({
        user_id: conversation.artist_id,
        type:    'message_request_accepted',
        title:   `${plannerProfile?.display_name ?? 'A booker'} accepted your message request`,
        data:    JSON.stringify({ conversation_id: conversationId }),
      });
    }

    return updated;
  }

  // ----------------------------------------------------------------
  // Get paginated messages for a conversation
  // ----------------------------------------------------------------
  async getMessages(userId: string, conversationId: string, dto: GetMessagesDto) {
    await this.assertParticipant(userId, conversationId);

    const page   = dto.page  ?? 1;
    const limit  = dto.limit ?? 50;
    const offset = (page - 1) * limit;

    const [messages, countRow] = await Promise.all([
      this.db('messages as m')
        .join(
          this.db.raw(
            `(SELECT u.id AS user_id,
                COALESCE(
                  (SELECT display_name FROM artist_profiles  WHERE user_id = u.id),
                  (SELECT display_name FROM planner_profiles WHERE user_id = u.id)
                ) AS display_name,
                COALESCE(
                  (SELECT thumbnail_url FROM artist_profiles  WHERE user_id = u.id),
                  (SELECT thumbnail_url FROM planner_profiles WHERE user_id = u.id)
                ) AS thumbnail_url
              FROM users u) AS sender_info`,
          ),
          'sender_info.user_id',
          'm.sender_id',
        )
        .where('m.conversation_id', conversationId)
        .select(
          'm.id',
          'm.sender_id',
          'm.body',
          'm.read_at',
          'm.created_at',
          'sender_info.display_name as sender_display_name',
          'sender_info.thumbnail_url as sender_thumbnail_url',
        )
        .orderBy('m.created_at', 'desc')   // newest first — client reverses for display
        .limit(limit)
        .offset(offset),

      this.db('messages')
        .where({ conversation_id: conversationId })
        .count('id as total')
        .first(),
    ]);
    const total = aggregateValue(countRow, 'total');

    return {
      data: messages,
      meta: {
        total,
        page,
        limit,
        pages:  Math.ceil(Number(total) / limit),
      },
    };
  }

  // ----------------------------------------------------------------
  // Send a message
  // ----------------------------------------------------------------
  async sendMessage(sender: UserRecord, conversationId: string, dto: SendMessageDto) {
    const conversation = await this.assertParticipant(sender.id, conversationId);

    // While a request is pending only the initiator may write, so the
    // request can carry an opening message for the planner to judge it
    // by. The planner accepting is what opens it up — replying without
    // accepting would make the accept step meaningless.
    if (conversation.status === 'declined') {
      throw new ForbiddenException('This conversation was declined.');
    }
    if (conversation.status === 'pending' && conversation.initiated_by !== sender.id) {
      throw new ForbiddenException('Accept this message request before replying.');
    }

    const [message] = await this.db.transaction(async (trx) => {
      const [msg] = await trx('messages')
        .insert({
          conversation_id: conversationId,
          sender_id:       sender.id,
          body:            dto.body,
        })
        .returning('*');

      // Keep last_message_at on the conversation in sync
      await trx('conversations')
        .where({ id: conversationId })
        .update({ last_message_at: msg.created_at });

      return [msg];
    });

    await this.notifyNewMessage(sender, conversation, conversationId);

    return message;
  }

  // Notifies whichever participant ISN'T the sender. Skips inserting a new
  // row if an unread "new_message" notification for this same conversation
  // already exists — otherwise a burst of messages before the recipient
  // checks their inbox would pile up as separate near-duplicate entries.
  private async notifyNewMessage(
    sender: UserRecord,
    conversation: { artist_id: string; planner_id: string },
    conversationId: string,
  ) {
    const recipientId =
      conversation.artist_id === sender.id ? conversation.planner_id : conversation.artist_id;

    const existingUnread = await this.db('notifications')
      .where({ user_id: recipientId, type: 'new_message' })
      .whereNull('read_at')
      .whereRaw(`data->>'conversation_id' = ?`, [conversationId])
      .first();
    if (existingUnread) return;

    const senderProfile = await this.db(
      sender.role === 'artist' ? 'artist_profiles' : 'planner_profiles',
    )
      .where({ user_id: sender.id })
      .select('display_name')
      .first();
    const senderName = senderProfile?.display_name ?? 'Someone';

    await this.db('notifications').insert({
      user_id: recipientId,
      type:    'new_message',
      title:   `New message from ${senderName}`,
      data:    JSON.stringify({ conversation_id: conversationId, sender_name: senderName }),
    });
  }

  // ----------------------------------------------------------------
  // Mark all unread messages in a thread as read
  // (only marks messages the user did NOT send)
  // ----------------------------------------------------------------
  async markRead(userId: string, conversationId: string) {
    await this.assertParticipant(userId, conversationId);

    const updated = await this.db('messages')
      .where({ conversation_id: conversationId })
      .where('read_at', null)
      .whereNot('sender_id', userId)
      .update({ read_at: this.db.fn.now() });

    return { markedRead: updated };
  }

  // ----------------------------------------------------------------
  // Get a single conversation (used internally and for GET /:id)
  // ----------------------------------------------------------------
  async getConversation(userId: string, conversationId: string) {
    const conversation = await this.db('conversations')
      .where({ id: conversationId })
      .first();

    if (!conversation) throw new NotFoundException('Conversation not found.');

    if (
      conversation.artist_id  !== userId &&
      conversation.planner_id !== userId
    ) {
      throw new ForbiddenException('You are not a participant in this conversation.');
    }

    return conversation;
  }

  // ----------------------------------------------------------------
  // Guard — throws if the user isn't a participant
  // ----------------------------------------------------------------
  private async assertParticipant(userId: string, conversationId: string) {
    const conversation = await this.db('conversations')
      .where({ id: conversationId })
      .first();

    if (!conversation) throw new NotFoundException('Conversation not found.');

    if (
      conversation.artist_id  !== userId &&
      conversation.planner_id !== userId
    ) {
      throw new ForbiddenException('You are not a participant in this conversation.');
    }

    return conversation;
  }
}
