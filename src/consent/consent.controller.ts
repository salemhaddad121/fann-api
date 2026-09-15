import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Req } from '@nestjs/common';
import { Request } from 'express';
import { ConsentService } from './consent.service';
import {
  AcceptDocumentsDto,
  SetMarketingConsentDto,
  UnsubscribeDto,
} from './dto/consent.dto';
import { readUnsubscribeToken } from './unsubscribe-token';
import { ConfigService } from '@nestjs/config';
import { ConsentDocument } from './consent.constants';
import { CurrentUser } from '../auth/decorators/auth.decorators';
import { UserRecord } from '../users/users.types';
import { clientIp } from '../common/request.util';
import { Public } from '../auth/decorators/auth.decorators';

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
  constructor(
    private readonly consentService: ConsentService,
    private readonly configService: ConfigService,
  ) {}

  // POST /consent/unsubscribe
  //
  // The one consent endpoint that takes no session (§24.2). Someone acting on
  // a link in their inbox has not signed in and should not have to: the
  // people most likely to unsubscribe are the ones least likely to still
  // have an account they can get into, and a withdrawal gated behind a
  // password is not a real withdrawal.
  //
  // POST rather than GET, and this is not pedantry. Mail scanners and link
  // prefetchers follow GET links in email, so a GET here would unsubscribe
  // people who never clicked anything. The link in the message goes to a
  // page; the page posts this.
  //
  // Always answers the same way. Telling an anonymous caller whether a token
  // was valid turns this into an oracle for whether an address is registered,
  // and the honest response to "stop emailing me" is identical either way.
  @Public()
  @Post('unsubscribe')
  @HttpCode(HttpStatus.OK)
  async unsubscribe(@Body() dto: UnsubscribeDto, @Req() req: Request) {
    const userId = readUnsubscribeToken(dto.token, this.configService);

    if (userId) {
      await this.consentService.setConsent(userId, 'marketing', false, {
        ipAddress: clientIp(req),
        userAgent: req.headers['user-agent'] ?? null,
      });
    }

    return {
      message: 'You have been unsubscribed from marketing emails.',
    };
  }

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
