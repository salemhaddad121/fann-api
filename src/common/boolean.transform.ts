import { Transform } from 'class-transformer';

/**
 * A boolean the validator will not invent.
 *
 * The global ValidationPipe runs with `enableImplicitConversion: true`
 * (app.module.ts), which is what lets `?page=2` arrive as a number. Applied
 * to a boolean field it is dangerous: class-transformer casts with
 * JavaScript truthiness, so EVERY non-empty string becomes `true` — the
 * string "false" included — before any validator sees the value.
 *
 * That is not a theoretical edge. Registering with `"acceptedTerms": "false"`
 * used to create the account and write a user_consents row saying the Terms
 * were accepted: the mandatory checkbox @Equals(true) is meant to enforce
 * was bypassable, and the evidence trail §3.4 exists to produce recorded
 * something the request had explicitly denied.
 *
 * Note this reads `obj[key]` — the ORIGINAL payload — and not the `value`
 * argument. With implicit conversion enabled class-transformer coerces
 * first and hands the custom transform what it already decided, so a
 * transform written against `value` sees `true` and can never tell it apart
 * from a real one. Reading the source object is what makes this work at
 * all, and it is why the obvious version of this helper silently does
 * nothing.
 *
 * Real booleans pass through, the two canonical string spellings are
 * accepted because form encodings legitimately produce them, and anything
 * else is returned UNCHANGED so that @IsBoolean or @Equals rejects it with
 * a 400. Falling through rather than defaulting is the point — for a
 * consent flag, guessing is the failure. Compare notifications.dto.ts,
 * which maps anything unrecognised to `false`; that is right for a read
 * filter and wrong here.
 */
export const StrictBoolean = () =>
  Transform(({ obj, key }) => {
    const raw = obj?.[key];
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  });
