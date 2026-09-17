// MUST be first. It sets the environment ConfigModule.forRoot() reads, and
// that call happens while app.module.ts is evaluated — see the file itself.
import '../test-utils/integration-env';

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Knex } from 'knex';
// import-equals, not a default import. This repo's tsconfig leaves
// esModuleInterop off, and supertest is CommonJS whose export IS the
// function — a default import yields undefined under that setting. Same
// reasoning as cookie-parser in main.ts, and this form works either way.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import request = require('supertest');
// Same form, same reason. The JWT cookie extractor reads req.cookies, which
// only exists once this middleware has run — without it every authenticated
// request in this file is a 401 and the test proves nothing.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cookieParser = require('cookie-parser');
import { AppModule } from '../app.module';
import { EmailService } from '../email/email.service';
import { StripNulBytesPipe } from '../common/nul-byte.pipe';
import { DatabaseExceptionFilter } from '../common/database-exception.filter';

/**
 * Registers through the API, then fetches the profile. Against a real
 * database.
 *
 * This is the test §8 of the audit asks for by name, and it is worth
 * stating why it did not exist. B1 — signup creating no artist_profiles or
 * planner_profiles row, so nobody who registered could finish onboarding —
 * was invisible to all 386 tests that passed at the time, because every one
 * of them starts from a fixture where the profile already exists. The
 * missing row was in the gap between "create a user" and "read a profile",
 * and nothing crossed that gap.
 *
 * It has to hit a real database rather than a mocked Knex for the same
 * reason. display_name was VARCHAR(150) NOT NULL; a mocked insert accepts
 * anything, so a unit test would have gone green against a statement
 * Postgres rejects.
 *
 * The whole chain runs: register, receive the verification link, open it,
 * log in, read the profile, write to it, read it back.
 *
 * Needs the dev database and Redis — `docker compose up -d db redis`. It
 * FAILS rather than skips when they are missing: a silent skip is how the
 * gap it covers stayed open.
 */
const RUN = process.env.SKIP_INTEGRATION_TESTS !== '1';

(RUN ? describe : describe.skip)('signup → profile (integration)', () => {
  let app: INestApplication;
  let db: Knex;
  const verificationLinks: string[] = [];
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      // Captures the link instead of sending it. This is the real
      // registration path — the token is the one the user would receive.
      .overrideProvider(EmailService)
      .useValue({
        sendVerificationEmail: jest.fn(async (_to: string, url: string) => {
          verificationLinks.push(url);
        }),
        sendPasswordResetEmail: jest.fn(),
        sendEmail: jest.fn(),
      })
      // Registration is capped at 5/minute per IP and, since B5, those
      // counters live in Redis and outlive the process — so a second run of
      // this file would be throttled by the first. Throttling has its own
      // tests; this one is about what signup creates.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();

    // The same bootstrap main.ts performs. A test app configured differently
    // from the real one proves things about an app nobody runs.
    app.setGlobalPrefix('api/v1', {
      exclude: [{ path: 'webhooks/payments/:provider', method: RequestMethod.POST }],
    });
    app.use(cookieParser());
    app.useGlobalFilters(new DatabaseExceptionFilter());
    app.useGlobalPipes(
      new StripNulBytesPipe(),
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );

    await app.init();
    db = app.get<Knex>('default');
  }, 60000);

  afterAll(async () => {
    if (createdEmails.length) {
      // Cascades clear the profile, consent and verification rows.
      await db('users').whereIn('email', createdEmails).delete();
    }
    await app?.close();
  }, 30000);

  const server = () => request(app.getHttpServer());

  async function registerAndVerify(role: 'artist' | 'planner') {
    const email = `integration.${role}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}@example.invalid`;
    createdEmails.push(email);

    const before = verificationLinks.length;

    await server()
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'Fann@dev2025',
        role,
        acceptedTerms: true,
        acceptedPrivacy: true,
        // The booker questionnaire (C2) is mandatory for a planner and
        // must not be sent for an artist — the artist branch is still one
        // step by design.
        ...(role === 'planner'
          ? { plannerKind: 'individual', interests: ['musical_acts'] }
          : {}),
      })
      .expect(201);

    // H9 — the account cannot be used until the emailed link is opened.
    await server()
      .post('/api/v1/auth/login')
      .send({ email, password: 'Fann@dev2025' })
      .expect(401);

    const link = verificationLinks[before];
    expect(link).toBeDefined();
    const token = new URL(link).searchParams.get('token');

    await server().get(`/api/v1/auth/verify-email?token=${token}`).expect(200);

    const login = await server()
      .post('/api/v1/auth/login')
      .send({ email, password: 'Fann@dev2025' })
      .expect(200);

    return { email, cookies: login.headers['set-cookie'] as unknown as string[] };
  }

  it('an artist can read their profile straight after signing up', async () => {
    // This returned 404 "Artist profile not found." for every account ever
    // created through the API, and /profile/edit was a permanent "Loading…"
    // with no inputs as a result.
    const { cookies } = await registerAndVerify('artist');

    const me = await server().get('/api/v1/artists/me').set('Cookie', cookies).expect(200);

    expect(me.body).toMatchObject({
      id: expect.any(String),
      user_id: expect.any(String),
      // No name yet, and that is the correct state — nobody has typed one.
      display_name: null,
    });
  }, 30000);

  it('and can then save a profile and read it back', async () => {
    // updateMe() reads the profile before patching it, so without the row
    // there was no way to create one by saving the form either.
    const { cookies } = await registerAndVerify('artist');

    await server()
      .put('/api/v1/artists/me')
      .set('Cookie', cookies)
      .send({ displayName: 'Integration Test Artist', bio: 'Oud and percussion.' })
      .expect(200);

    const me = await server().get('/api/v1/artists/me').set('Cookie', cookies).expect(200);

    expect(me.body).toMatchObject({
      display_name: 'Integration Test Artist',
      bio: 'Oud and percussion.',
    });
  }, 30000);

  it('a planner can read their profile straight after signing up', async () => {
    const { cookies } = await registerAndVerify('planner');

    const me = await server().get('/api/v1/planners/me').set('Cookie', cookies).expect(200);

    expect(me.body).toMatchObject({
      id: expect.any(String),
      user_id: expect.any(String),
      display_name: null,
    });
  }, 30000);

  it('records consent and a verification record alongside the profile', async () => {
    const { email } = await registerAndVerify('artist');

    const user = await db('users').where({ email }).first();
    const consents = await db('user_consents').where({ user_id: user.id });
    const verifications = await db('verification_records').where({ user_id: user.id });

    expect(consents.map((c: { document: string }) => c.document).sort()).toEqual([
      'privacy',
      'terms',
    ]);
    expect(verifications).toHaveLength(1);
  }, 30000);

  // H1 — the unique constraint is case-sensitive, so this used to return
  // 201 and create a second account sharing one mailbox.
  it('refuses the same address in a different case', async () => {
    const { email } = await registerAndVerify('artist');

    await server()
      .post('/api/v1/auth/register')
      .send({
        email: email.toUpperCase(),
        password: 'Fann@dev2025',
        role: 'planner',
        plannerKind: 'individual',
        interests: ['musical_acts'],
        acceptedTerms: true,
        acceptedPrivacy: true,
      })
      .expect(409);
  }, 30000);
});
