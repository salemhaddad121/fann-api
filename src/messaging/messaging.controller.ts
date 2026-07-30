import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { MessagingService } from './messaging.service';
import {
  CreateConversationDto,
  GetMessagesDto,
  RespondToRequestDto,
  SendMessageDto,
} from './dto/messaging.dto';
import { JwtAuthGuard } from '../auth/guards/auth.guards';
import { CurrentUser } from '../auth/decorators/auth.decorators';
import { UserRecord } from '../users/users.types';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  // GET /conversations
  @Get()
  list(@CurrentUser() user: UserRecord) {
    return this.messagingService.listConversations(user);
  }

  // POST /conversations
  // Planners send artistId and get an open thread. Artists send plannerId
  // and get a pending request the planner has to accept.
  @Post()
  create(
    @CurrentUser() user: UserRecord,
    @Body() dto: CreateConversationDto,
  ) {
    return this.messagingService.createConversation(user, dto);
  }

  // PATCH /conversations/:id/respond
  // Planner accepts or declines an artist's message request.
  @Patch(':id/respond')
  @HttpCode(HttpStatus.OK)
  respondToRequest(
    @CurrentUser() user: UserRecord,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() dto: RespondToRequestDto,
  ) {
    return this.messagingService.respondToRequest(user, conversationId, dto.decision);
  }

  // GET /conversations/:id
  @Get(':id')
  getOne(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) conversationId: string,
  ) {
    return this.messagingService.getConversation(userId, conversationId);
  }

  // GET /conversations/:id/messages?page=1&limit=50
  @Get(':id/messages')
  getMessages(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Query() dto: GetMessagesDto,
  ) {
    return this.messagingService.getMessages(userId, conversationId, dto);
  }

  // POST /conversations/:id/messages
  @Post(':id/messages')
  sendMessage(
    @CurrentUser() user: UserRecord,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.messagingService.sendMessage(user, conversationId, dto);
  }

  // PUT /conversations/:id/read
  // Marks all unread messages in the thread (sent by the other party) as read.
  @Put(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) conversationId: string,
  ) {
    return this.messagingService.markRead(userId, conversationId);
  }
}
