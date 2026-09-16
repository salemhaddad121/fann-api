import { Injectable, PipeTransform } from '@nestjs/common';

/**
 * Removes NUL bytes (U+0000) from every string reaching a handler.
 *
 * Postgres text columns cannot hold one. Passing `\0` through in a query
 * parameter raises 22021 ("unsupported Unicode escape sequence") from inside
 * the driver, which is a 500 — and on `GET /artists?q=%00` and
 * `GET /planners?q=%00` that 500 needs no session at all. Any anonymous
 * visitor could error the busiest public endpoint on the site, repeatedly,
 * with a four-character query string.
 *
 * Stripping rather than rejecting, deliberately. A NUL in a search box is
 * never meaningful input, so there is nothing to tell the caller about; and
 * a strip is total, where a reject only covers the fields someone remembered
 * to annotate. DatabaseExceptionFilter still maps 22021 to a 400 as a
 * backstop for any path that reaches SQL without passing through here.
 *
 * Registered ahead of the global ValidationPipe (app.module.ts) so the value
 * a validator sees is the cleaned one.
 */
@Injectable()
export class StripNulBytesPipe implements PipeTransform {
  transform(value: unknown): unknown {
    return strip(value);
  }
}

// Depth is bounded by the request body the JSON parser already accepted, so
// this cannot recurse further than that parse did.
function strip(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
  }

  if (Array.isArray(value)) {
    return value.map(strip);
  }

  // Plain objects only. A Date, a Buffer or a class instance is left alone —
  // rebuilding one from its own enumerable keys would quietly turn it into
  // something else.
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = strip(val);
    }
    return out;
  }

  return value;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
