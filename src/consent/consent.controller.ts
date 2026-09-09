import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { ConsentService } from './consent.service';
import { AcceptDocumentsDto, SetMarketingConsentDto } from './dto/consent.dto';
import { ConsentDocument } from './consent.constants';
import { CurrentUser } from '../auth/decorators/auth.decorators';
import { UserRecord } from '../users/users.types';
import { clientIp } from '../common/request.util';

/**
 * Consent: what still needs agreeing to, and the two ways to agree.
 *
 * The split is deliberate. Marketing is a PREFERENCE — PUT it on or off,
 * any number of times (§24.2). Terms and privacy are CONDITIONS — POST an
 * acceptance, which only ever appends and can never be turned off here
 * (§33.2). Collapsing them into one endpoint would mean a shape that can
 * express "withdraw my acceptance of the Terms", which is not a preference
 * change but account closure.
 */
@Controller('consent')
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  // GET /consent/status
  //
  // What the re-acceptance prompt reads. Returns the mandatory documents
  // this account has not accepted at their current version — after an
  // amendment (§33.2), and also for any account that predates consent
  // being recorded at all.
  @Get('status')
  async getStatus(@CurrentUser('id') userId: string) {
    const outdated = await this.consentService.outdatedDocuments(userId);
    return { outdated, needs_acceptance: outdated.length > 0 };
  }

  // POST /consent/accept
  //
  // Records acceptance of the named documents at whatever version is live
  // now. The versions are NOT taken from the request: a client that could
  // name the version could record agreement to wording the user was never
  // shown, and the stored version is the whole of the evidence.
  @Post('accept')
  @HttpCode(HttpStatus.OK)
  async accept(
    @CurrentUser() user: UserRecord,
    @Body() dto: AcceptDocumentsDto,
    @Req() req: Request,
  ) {
    await this.consentService.record(
      user.id,
      dto.documents as ConsentDocument[],
      {
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
        contactEmail: user.email ?? null,
      },
    );

    return { outdated: await this.consentService.outdatedDocuments(user.id) };
  }

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
