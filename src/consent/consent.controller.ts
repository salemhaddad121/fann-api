import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { ConsentService } from './consent.service';
import { SetMarketingConsentDto } from './dto/consent.dto';
import { CurrentUser } from '../auth/decorators/auth.decorators';
import { UserRecord } from '../users/users.types';
import { clientIp } from '../common/request.util';

/**
 * Communication preferences.
 *
 * Only marketing is exposed. Terms and privacy are conditions of use and
 * the service refuses to change them here — this endpoint is the "and
 * withdrawable" half of T&C §24.2, not a general consent editor.
 */
@Controller('consent')
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  // GET /consent/marketing
  @Get('marketing')
  async getMarketing(@CurrentUser('id') userId: string) {
    return { granted: await this.consentService.isGranted(userId, 'marketing') };
  }

  // PUT /consent/marketing
  //
  // PUT rather than PATCH: the body is the whole of the resource, and
  // sending the same value twice is meant to be safe. It does append a
  // second row, which is intentional — "confirmed again on the 9th" is a
  // fact worth having, and de-duplicating would mean the table no longer
  // records what the user actually did.
  @Put('marketing')
  async setMarketing(
    @CurrentUser() user: UserRecord,
    @Body() dto: SetMarketingConsentDto,
    @Req() req: Request,
  ) {
    // Same reasoning as signup: an acceptance — or a withdrawal — without
    // the address and client that made it is weak evidence, and only the
    // request layer knows them.
    await this.consentService.setConsent(user.id, 'marketing', dto.granted, {
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
      contactEmail: user.email ?? null,
    });

    return { granted: dto.granted };
  }
}
