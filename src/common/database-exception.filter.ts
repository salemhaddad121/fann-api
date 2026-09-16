import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Maps PostgreSQL driver errors onto HTTP status codes.
 *
 * The hostile-input sweep of 2026-09-15 produced 1,753 server errors across
 * ten routes, every one of them a raw node-postgres error escaping as an
 * untyped 500. They were not ten bugs — they were one missing piece of
 * infrastructure. A validator gap anywhere reaches SQL eventually, and
 * without this the first thing the caller learns about it is a 500 carrying
 * the driver's own message.
 *
 * The mapping is deliberately conservative. Anything not listed stays a 500,
 * because a SQLSTATE nobody has reasoned about is a bug in this codebase,
 * not bad input, and dressing it up as a 400 would hide it.
 */
const STATUS_BY_SQLSTATE: Record<string, number> = {
  // Foreign key violation — the row the caller named does not exist.
  '23503': HttpStatus.NOT_FOUND,
  // Unique violation — it exists already.
  '23505': HttpStatus.CONFLICT,

  // Everything below is malformed input that validation should have caught
  // first. It is still a 400 when it doesn't: the caller sent something the
  // column cannot hold, and that is their side of the exchange, not ours.
  '22P02': HttpStatus.BAD_REQUEST, // invalid text representation (enum, uuid, int)
  '22021': HttpStatus.BAD_REQUEST, // character not in repertoire — NUL byte
  '22007': HttpStatus.BAD_REQUEST, // invalid datetime format
  '22008': HttpStatus.BAD_REQUEST, // datetime field overflow
  '22003': HttpStatus.BAD_REQUEST, // numeric value out of range
  '22009': HttpStatus.BAD_REQUEST, // invalid time zone displacement
  '2201W': HttpStatus.BAD_REQUEST, // invalid row count in LIMIT
  '42601': HttpStatus.BAD_REQUEST, // syntax error — scalar handed to whereIn
  '23502': HttpStatus.BAD_REQUEST, // not-null violation
  '23514': HttpStatus.BAD_REQUEST, // check constraint violation
};

/**
 * What the client is told. Never the driver's message: it names tables,
 * columns and constraints, and on a unique violation it echoes the
 * conflicting value straight back.
 */
const MESSAGE_BY_STATUS: Record<number, string> = {
  [HttpStatus.NOT_FOUND]:   'The requested resource was not found.',
  [HttpStatus.CONFLICT]:    'That record already exists.',
  [HttpStatus.BAD_REQUEST]: 'One or more values in the request are not valid.',
};

interface PostgresError extends Error {
  code?: string;
  // node-postgres attaches these; knex re-throws the same object.
  detail?: string;
  constraint?: string;
  table?: string;
  routine?: string;
}

function isPostgresError(err: unknown): err is PostgresError {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as PostgresError).code;
  // Every SQLSTATE is five alphanumeric characters. Checking the shape
  // rather than a list keeps an unmapped code out of the generic 500
  // handler's way while still letting it fall through as one.
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}

@Catch()
export class DatabaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DatabaseExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ method?: string; url?: string }>();

    // A thrown HttpException is the application speaking on purpose. Pass it
    // through untouched — re-deriving its body here is how a deliberate 403
    // turns into a generic 500 the day someone adds a field to it.
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (isPostgresError(exception)) {
      const status = STATUS_BY_SQLSTATE[exception.code!];

      if (status) {
        // Logged in full at error level — the driver's message is the only
        // thing that makes one of these diagnosable, and it must not be the
        // thing the client receives.
        this.logger.error(
          `${request?.method ?? '?'} ${request?.url ?? '?'} — pg ${exception.code}: ${exception.message}`,
          exception.stack,
        );

        response.status(status).json({
          statusCode: status,
          message: MESSAGE_BY_STATUS[status] ?? 'Request could not be completed.',
          error: HttpStatus[status],
        });
        return;
      }
    }

    // Anything else is a genuine server fault.
    const err = exception as Error;
    this.logger.error(
      `${request?.method ?? '?'} ${request?.url ?? '?'} — unhandled: ${err?.message ?? String(exception)}`,
      err?.stack,
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'Internal Server Error',
    });
  }
}
