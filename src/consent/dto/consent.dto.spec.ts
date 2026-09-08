import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SetMarketingConsentDto } from './consent.dto';

// enableImplicitConversion mirrors the global ValidationPipe in
// app.module.ts. Omitting it would make these pass for the wrong reason.
const PIPE_OPTS = { enableImplicitConversion: true };

function build(granted: unknown) {
  return plainToInstance(SetMarketingConsentDto, { granted }, PIPE_OPTS);
}

describe('SetMarketingConsentDto', () => {
  it.each([[true], [false]])('accepts the boolean %p', async (granted) => {
    expect(await validate(build(granted))).toHaveLength(0);
  });

  it('reads the string "false" as a withdrawal, not a grant', async () => {
    // The dangerous direction. Under implicit conversion alone this became
    // `true`, so an attempt to withdraw consent recorded granting it.
    const dto = build('false');

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.granted).toBe(false);
  });

  it('reads the string "true" as a grant', async () => {
    const dto = build('true');

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.granted).toBe(true);
  });

  it.each([['yes'], ['no'], ['0'], ['1'], [''], [null]])(
    'rejects %p rather than defaulting either way',
    async (granted) => {
      expect((await validate(build(granted))).length).toBeGreaterThan(0);
    },
  );

  it('rejects a missing body field', async () => {
    expect((await validate(plainToInstance(SetMarketingConsentDto, {}, PIPE_OPTS))).length)
      .toBeGreaterThan(0);
  });
});
