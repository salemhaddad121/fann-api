import { NestFactory } from '@nestjs/core';
import * as cookieParser from 'cookie-parser';
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
