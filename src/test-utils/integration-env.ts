/**
 * Environment defaults for tests that boot the real AppModule.
 *
 * A side-effect import, and it has to be, because of when this needs to
 * run. `ConfigModule.forRoot()` is CALLED while app.module.ts is being
 * evaluated — it sits in a @Module decorator's imports array — and ES
 * imports are hoisted, so assignments written at the top of a spec file
 * execute after that. Importing this FIRST is what puts them before it.
 *
 * `??=` throughout: a real value already in the environment always wins, so
 * pointing a run at another database is a matter of exporting DATABASE_URL.
 *
 * The S3 and JWT values exist only so the container can construct every
 * service at boot. Nothing in an integration test signs a real token or
 * touches a bucket.
 */
process.env.DATABASE_URL ||= 'postgresql://postgres:fann_dev@localhost:5432/fann';
process.env.REDIS_URL ||= 'redis://localhost:6379';
process.env.JWT_SECRET ||= 'integration-test-secret';
process.env.JWT_REFRESH_SECRET ||= 'integration-test-refresh-secret';
process.env.AWS_REGION ||= 'auto';
process.env.AWS_ACCESS_KEY_ID ||= 'test';
process.env.AWS_SECRET_ACCESS_KEY ||= 'test';
process.env.S3_BUCKET ||= 'fann-media-test';
process.env.CDN_BASE_URL ||= 'https://cdn.test.invalid';
process.env.APP_URL ||= 'http://localhost:3000';
process.env.FRONTEND_URL ||= 'http://localhost:3000';

// Nothing should schedule background work during a test run. 'http' puts the
// jobs behind the /cron routes instead of an in-process timer.
process.env.SCHEDULER_MODE = 'http';

export {};
