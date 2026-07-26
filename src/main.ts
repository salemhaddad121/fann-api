import { NestFactory } from '@nestjs/core';
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
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

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
