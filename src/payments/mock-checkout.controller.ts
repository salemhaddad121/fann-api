import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { MockProvider, MOCK_SIGNATURE_HEADER } from './providers/mock.provider';
import { WebhooksService } from './webhooks.service';
import { Public } from '../auth/decorators/auth.decorators';

/**
 * Stand-in for a provider's hosted checkout page. DEV ONLY.
 *
 * Exists so the redirect half of the flow is actually exercised: the
 * frontend redirects here, a button is pressed, and a correctly-signed
 * webhook comes back through the same code a real provider would hit —
 * signature check included. Without it the automated path could only be
 * tested by hand-crafting webhooks, which skips the redirect entirely.
 *
 * Every route refuses unless PAYMENT_PROVIDER=mock, so this cannot mint
 * subscriptions on an environment running a real provider.
 */
@Controller('payments/mock')
@Public()
export class MockCheckoutController {
  constructor(
    @InjectConnection() private readonly db: Knex,
    private readonly mockProvider: MockProvider,
    private readonly webhooksService: WebhooksService,
    private readonly configService: ConfigService,
  ) {}

  private assertMockEnabled() {
    if (this.configService.get<string>('PAYMENT_PROVIDER') !== 'mock') {
      throw new ForbiddenException(
        'The mock checkout is only available when PAYMENT_PROVIDER=mock.',
      );
    }
  }

  // GET /api/v1/payments/mock/checkout/:ref — the fake hosted page
  @Get('checkout/:ref')
  @Header('Content-Type', 'text/html')
  async checkout(@Param('ref') ref: string): Promise<string> {
    this.assertMockEnabled();

    const payment = await this.db('payments')
      .where({ provider: 'mock', provider_ref: ref })
      .first();
    if (!payment) throw new NotFoundException('Unknown payment reference.');

    const amount = Number(payment.amount_usd).toFixed(2);

    // Plain server-rendered HTML. This is a test fixture, not product UI —
    // giving it a framework would be more code to maintain than the thing
    // it stands in for.
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock checkout</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
 .card{border:1px solid #ddd;border-radius:12px;padding:1.5rem}
 button{width:100%;padding:.75rem;border:0;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
 .pay{background:#166534;color:#fff}.fail{background:#fff;color:#7F1D1D;border:1px solid #FCA5A5;margin-top:.5rem}
 .warn{background:#FEF3C7;border:1px solid #FCD34D;padding:.6rem;border-radius:8px;font-size:.8rem}
</style></head>
<body>
  <p class="warn">Mock provider — no real money moves here.</p>
  <div class="card">
    <h2>Pay $${amount} ${payment.currency}</h2>
    <p style="color:#666;font-size:.9rem">Reference ${ref}</p>
    <!--
      Plain forms, no JavaScript. helmet() sets script-src 'self' and
      script-src-attr 'none', so an inline script or an onclick handler is
      blocked outright — and relaxing the CSP of the whole API for a dev
      fixture would be a poor trade. Form posts need no script at all, and
      a real hosted checkout is usually a form post anyway.
    -->
    <form method="post" action="/api/v1/payments/mock/${ref}/complete?status=paid">
      <button class="pay" type="submit">Pay now</button>
    </form>
    <form method="post" action="/api/v1/payments/mock/${ref}/complete?status=failed">
      <button class="fail" type="submit">Simulate failure</button>
    </form>
  </div>
</body></html>`;
  }

  /**
   * Fires a correctly-signed webhook at our own handler.
   *
   * Signed server-side because the secret is server-side — the browser
   * cannot compute the HMAC, which is exactly the property that makes
   * signatures worth verifying.
   */
  @Post(':ref/complete')
  async complete(
    @Param('ref') ref: string,
    @Res() res: Response,
    @Query('status') status?: string,
  ) {
    this.assertMockEnabled();

    const payment = await this.db('payments')
      .where({ provider: 'mock', provider_ref: ref })
      .first();
    if (!payment) throw new NotFoundException('Unknown payment reference.');

    // The failure path matters as much as the success one: a provider
    // reporting a declined payment must move the row to rejected without
    // minting anything, and that is only tested if it can be triggered.
    const reported = status === 'failed' ? 'failed' : 'paid';

    const payload = {
      event: reported === 'paid' ? 'payment.completed' : 'payment.failed',
      reference: ref,
      status: reported,
      amount: Number(payment.amount_usd),
      currency: payment.currency ?? 'USD',
    };

    const rawBody = Buffer.from(JSON.stringify(payload));
    const outcome = await this.webhooksService.process('mock', rawBody, {
      [MOCK_SIGNATURE_HEADER]: this.mockProvider.sign(rawBody),
    });

    // Send the buyer back the way a real hosted checkout would, so the
    // return page and its polling get exercised rather than assumed. The
    // outcome rides along as a query param for debugging only — the page
    // polls the API for the real answer rather than trusting the redirect.
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';

    return res.redirect(
      `${frontendUrl}/plans/return?payment=${payment.id}&outcome=${outcome}`,
    );
  }
}
