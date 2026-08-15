import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IdentityDocumentsService } from './identity-documents.service';
import {
  ConfirmIdDocumentDto,
  PresignIdDocumentDto,
} from './dto/identity-documents.dto';
import { JwtAuthGuard, RolesGuard } from '../auth/guards/auth.guards';
import { CurrentUser, Roles } from '../auth/decorators/auth.decorators';

/**
 * Artist-facing identity verification.
 *
 * Artists only. Bookers are not gated on ID — the day pass explicitly
 * skips it — so exposing this to them would invite uploads of documents
 * nobody asked for and nobody should be storing.
 */
@Controller('verification')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('artist')
export class IdentityDocumentsController {
  constructor(private readonly identityDocuments: IdentityDocumentsService) {}

  // GET /verification/me — the checklist, including what is still missing
  @Get('me')
  getMine(@CurrentUser('id') userId: string) {
    return this.identityDocuments.getMine(userId);
  }

  // POST /verification/documents/presign
  @Post('documents/presign')
  presign(@CurrentUser('id') userId: string, @Body() dto: PresignIdDocumentDto) {
    return this.identityDocuments.presign(userId, dto);
  }

  // POST /verification/documents/confirm
  @Post('documents/confirm')
  confirm(@CurrentUser('id') userId: string, @Body() dto: ConfirmIdDocumentDto) {
    return this.identityDocuments.confirm(userId, dto);
  }
}
