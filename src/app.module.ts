import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { KnexModule } from 'nest-knexjs';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule }         from './auth/auth.module';
import { RedisModule }        from './redis/redis.module';
import { EmailModule }        from './email/email.module';
import { UsersModule }        from './users/users.module';
import { ArtistsModule }      from './artists/artists.module';
import { PlannersModule }     from './planners/planners.module';
import { MediaModule }        from './media/media.module';
import { AvailabilityModule } from './availability/availability.module';
import { MessagingModule }    from './messaging/messaging.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AdminModule }        from './admin/admin.module';
import { BookingsModule }     from './bookings/bookings.module';
import { ReviewsModule }      from './reviews/reviews.module';
import { SchedulerModule }    from './scheduler/scheduler.module';
import { SavedModule }        from './saved/saved.module';
import { AnalyticsModule }    from './analytics/analytics.module';

@Module({
  imports: [
    // Config — make process.env available everywhere via ConfigService
    ConfigModule.forRoot({ isGlobal: true }),

    // Database — Knex + PostgreSQL
    KnexModule.forRootAsync({
      useFactory: () => ({
        config: {
          client: 'postgresql',
          connection: {
            host:     process.env.DB_HOST     ?? 'localhost',
            port:     Number(process.env.DB_PORT ?? 5432),
            database: process.env.DB_NAME     ?? 'fann',
            user:     process.env.DB_USER     ?? 'postgres',
            password: process.env.DB_PASSWORD ?? '',
          },
          pool: { min: 2, max: 10 },
        },
      }),
    }),

    // Rate limiting — registered globally so ThrottlerGuard resolves anywhere,
    // but only ENFORCED on the auth routes that opt in via
    // @UseGuards(ThrottlerGuard). Default bucket: 10 requests / 60s per IP.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }]),

    RedisModule,
    EmailModule,
    UsersModule,
    AuthModule,
    ArtistsModule,
    PlannersModule,
    MediaModule,
    AvailabilityModule,
    MessagingModule,
    NotificationsModule,
    AdminModule,
    BookingsModule,
    ReviewsModule,
    SchedulerModule,
    SavedModule,
    AnalyticsModule,
  ],
  providers: [
    // Global validation pipe — applies to every route automatically
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist:        true,   // strip unknown fields
        forbidNonWhitelisted: true,
        transform:        true,   // auto-cast primitives (e.g. string → number)
        transformOptions: { enableImplicitConversion: true },
      }),
    },
  ],
})
export class AppModule {}
