import { BadRequestException, ForbiddenException, HttpStatus } from '@nestjs/common';
import { DatabaseExceptionFilter } from './database-exception.filter';
import { StripNulBytesPipe } from './nul-byte.pipe';

function hostFor(method = 'GET', url = '/api/v1/artists') {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ method, url }),
      }),
    } as any,
    status,
    json,
  };
}

describe('DatabaseExceptionFilter', () => {
  let filter: DatabaseExceptionFilter;

  beforeEach(() => {
    filter = new DatabaseExceptionFilter();
    // The filter logs every mapped error at error level. Silenced so a
    // passing run does not print ten stack traces.
    jest.spyOn((filter as any).logger, 'error').mockImplementation(() => undefined);
  });

  // The ten SQLSTATEs the hostile-input sweep actually produced, with the
  // status each is supposed to become.
  it.each([
    ['23503', HttpStatus.NOT_FOUND],
    ['23505', HttpStatus.CONFLICT],
    ['22P02', HttpStatus.BAD_REQUEST],
    ['22021', HttpStatus.BAD_REQUEST],
    ['22007', HttpStatus.BAD_REQUEST],
    ['22003', HttpStatus.BAD_REQUEST],
    ['22008', HttpStatus.BAD_REQUEST],
    ['23502', HttpStatus.BAD_REQUEST],
    ['2201W', HttpStatus.BAD_REQUEST],
    ['42601', HttpStatus.BAD_REQUEST],
    ['22009', HttpStatus.BAD_REQUEST],
  ])('maps pg %s to %i', (code, expected) => {
    const { host, status, json } = hostFor();
    const err = Object.assign(new Error('invalid input syntax for type date'), { code });

    filter.catch(err, host);

    expect(status).toHaveBeenCalledWith(expected);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: expected }),
    );
  });

  it('never returns the driver message to the client', () => {
    const { host, json } = hostFor();
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_key"'),
      { code: '23505', detail: 'Key (email)=(victim@example.com) already exists.' },
    );

    filter.catch(err, host);

    const body = JSON.stringify(json.mock.calls[0][0]);
    expect(body).not.toContain('users_email_key');
    expect(body).not.toContain('victim@example.com');
  });

  it('logs the original at error level', () => {
    const { host } = hostFor('POST', '/api/v1/saved-artists/x');
    const spy = (filter as any).logger.error as jest.Mock;

    filter.catch(Object.assign(new Error('boom'), { code: '23503' }), host);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('23503'),
      expect.anything(),
    );
  });

  it('passes a deliberate HttpException through untouched', () => {
    const { host, status, json } = hostFor();

    filter.catch(new ForbiddenException('Not your booking.'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Not your booking.' }),
    );
  });

  it('keeps a validation 400 as a 400 with its field messages', () => {
    const { host, status, json } = hostFor();

    filter.catch(new BadRequestException(['availableOn must be a valid ISO 8601 date string']), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json.mock.calls[0][0].message).toEqual([
      'availableOn must be a valid ISO 8601 date string',
    ]);
  });

  // An unmapped SQLSTATE is a bug in this codebase, not bad input. It must
  // keep surfacing as a 500 rather than being dressed up as a 400.
  it('leaves an unmapped SQLSTATE as a 500', () => {
    const { host, status, json } = hostFor();

    filter.catch(Object.assign(new Error('deadlock detected'), { code: '40P01' }), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json.mock.calls[0][0].message).toBe('Internal server error');
  });

  it('leaves an ordinary Error as a 500', () => {
    const { host, status } = hostFor();
    filter.catch(new Error('undefined is not a function'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});

describe('StripNulBytesPipe', () => {
  const pipe = new StripNulBytesPipe();

  it('strips a NUL from a query value', () => {
    // GET /artists?q=%00 — a 500 on the public search, with no session.
    expect(pipe.transform({ q: '\u0000' })).toEqual({ q: '' });
  });

  it('strips NULs from inside a string, keeping the rest', () => {
    expect(pipe.transform({ bio: 'ka\u0000rim' })).toEqual({ bio: 'karim' });
  });

  it('recurses through arrays and nested objects', () => {
    expect(
      pipe.transform({ languages: ['a\u0000b'], socialLinks: { instagram: 'x\u0000' } }),
    ).toEqual({ languages: ['ab'], socialLinks: { instagram: 'x' } });
  });

  it('leaves non-strings alone', () => {
    const value = { page: 2, verifiedOnly: true, city: null, when: undefined };
    expect(pipe.transform(value)).toEqual(value);
  });

  it('does not rebuild a Date into a plain object', () => {
    const when = new Date('2026-09-16T00:00:00.000Z');
    expect((pipe.transform({ when }) as any).when).toBe(when);
  });
});
