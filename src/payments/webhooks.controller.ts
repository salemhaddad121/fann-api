import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WebhooksService } from './webhooks.service';

/**
 * Inbound provider callbacks.
 *
 * Mounted OUTSIDE the api/v1 prefix (see main.ts) because a provider's
 * callback URL is registered once in their dashboard and should not carry
 * our internal versioning — bumping to api/v2 would silently break live
 * payments.
 *
 * Not throttled. Providers burst on retry, and rate-limiting a payment
 * callback drops confirmations for money that has already left someone's
 * account.
 */
@Controller('webhooks/payments')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  /**
   * ALWAYS answers 200, including for a rejected signature or an unknown
   * payment.
   *
   * This looks wrong and is deliberate: most providers treat any 4xx or
   * 5xx as "retry", and will keep retrying for hours. A malformed event
   * answered with 400 becomes a retry storm that buries the real traffic.
   * Everything is recorded in payment_webhook_events regardless, which is
   * where a failure is actually investigated.
   */
  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('provider') provider: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ) {
    // rawBody, never req.body: the signature is an HMAC over the exact
    // bytes sent, and re-serialising the parsed object does not reproduce
    // them. Enabled by NestFactory.create(..., { rawBody: true }).
    const rawBody = req.rawBody ?? Buffer.from('');

    const outcome = await this.webhooksService.process(provider, rawBody, headers);

    // The outcome is returned for our own logs and tests. Providers ignore
    // the body; only the status code matters to them.
    return { received: true, outcome };
  }
}
