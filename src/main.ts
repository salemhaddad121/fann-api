import { NestFactory } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
// import-equals, not `import * as`, deliberately. cookie-parser is a
// CommonJS module whose export is the function itself. Under
// esModuleInterop:false `import * as` yields that function and is callable;
// under esModuleInterop:true it yields a namespace object and calling it is
// a compile error (TS2349). This repo's tsconfig leaves the flag off, but
// Vercel's NestJS preset turns it on — so the build passed locally and in
// Docker while failing there. This form is callable either way.
import cookieParser = require('cookie-parser');
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody keeps an untouched Buffer copy of every request body alongside
  // the parsed one, reachable as req.rawBody.
  //
  // Payment providers sign their webhooks with an HMAC over the exact bytes
  // they sent. Re-serialising the parsed JSON does not reproduce those bytes
  // — key order, whitespace and number formatting are all free to change —
  // so once the raw body is discarded the signature can never be verified
  // again. There is no way to add this later without touching bootstrap
  // after cookies, CORS and helmet are all live, and you would only find out
  // it was missing when pointing a real provider at the endpoint for the
  // first time.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Payment webhooks sit outside the version prefix. A provider's callback
  // URL is registered once in their dashboard, and bumping to api/v2 would
  // silently stop confirming payments for money that had already left
  // customers' accounts.
  app.setGlobalPrefix('api/v1', {
    exclude: [{ path: 'webhooks/payments/:provider', method: RequestMethod.POST }],
  });

  // Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, …)
  // applied to every response.
  app.use(helmet());
  app.use(cookieParser());

  app.enableCors({
    origin:      process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
  });

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  console.log(`Fann API running on http://localhost:${port}/api/v1`);
}

bootstrap();
