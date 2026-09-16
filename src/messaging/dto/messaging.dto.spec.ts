import { ValidationPipe } from '@nestjs/common';
import { SendMessageDto } from './messaging.dto';

// The same pipe configuration app.module.ts registers globally.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const send = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: SendMessageDto });

describe('SendMessageDto', () => {
  // M2 — @IsNotEmpty() only rejects the empty string, and three spaces is
  // not the empty string. A body of three spaces returned 201 and put a
  // blank bubble in the conversation.
  it('rejects a whitespace-only message', async () => {
    await expect(send({ body: '   ' })).rejects.toThrow();
  });

  it.each(['\t', '\n', '  \t \n  ', ''])('rejects %j', async (body) => {
    await expect(send({ body })).rejects.toThrow();
  });

  it('stores the trimmed value, so padding never reaches the database', async () => {
    await expect(send({ body: '  hello  ' })).resolves.toMatchObject({ body: 'hello' });
  });

  it('measures the length cap against the trimmed body, not the padding', async () => {
    // Trimming in the service instead would be too late: the validator has
    // already approved by then and the cap was measured against whitespace.
    const padded = `${' '.repeat(500)}${'x'.repeat(4000)}${' '.repeat(500)}`;

    await expect(send({ body: padded })).resolves.toMatchObject({
      body: 'x'.repeat(4000),
    });
  });

  it('still rejects a body over the cap once trimmed', async () => {
    await expect(send({ body: 'x'.repeat(4001) })).rejects.toThrow();
  });

  it('leaves internal whitespace alone', async () => {
    await expect(send({ body: 'are you free\non the 3rd?' })).resolves.toMatchObject({
      body: 'are you free\non the 3rd?',
    });
  });
});
