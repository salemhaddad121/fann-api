import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * The social links a profile may carry — a fixed key set, one URL each.
 *
 * It was `Record<string, string>` with `@IsObject()`, which validates the
 * container and nothing in it: any key, any value, any length. A single
 * value of 50,000 characters was accepted and stored, and so was
 * `javascript:alert(1)`.
 *
 * The `javascript:` case is not exploitable today — SocialLinks.tsx on the
 * web side rewrites anything not starting with `http` into an https URL
 * before it reaches an href. That guard is one component's private habit,
 * though, and the API is what every future consumer reads from. Storing a
 * value that is only safe because of where it currently happens to be
 * rendered is the part worth fixing.
 *
 * Declared as a class rather than an index signature because that is what
 * makes the key set enforceable: with `@ValidateNested()` on the parent, the
 * global pipe's `forbidNonWhitelisted` rejects a key that is not a property
 * here, so "myspace" is a 400 rather than a row in the database.
 */

// The empty string is how a form clears a field. Mapping it to undefined
// lets @IsOptional() handle it as "not set" instead of failing @IsUrl on a
// value the user is trying to remove.
const BlankToUndefined = () =>
  Transform(({ value }) => (value === '' ? undefined : value));

// Protocol is not required — "instagram.com/name" is a link a person
// reasonably types, and the web client already prepends https:// to
// anything without a scheme. What the allowlist stops is a value that
// declares a scheme this is not: `javascript:`, `data:`, `file:`.
const LINK_OPTIONS = { protocols: ['http', 'https'], require_protocol: false };

// Comfortably longer than any real profile URL, and short enough that the
// column and every search response carrying it stay bounded.
const MAX_LINK_LENGTH = 300;

export class SocialLinksDto {
  @IsOptional()
  @BlankToUndefined()
  @IsString()
  @MaxLength(MAX_LINK_LENGTH)
  @IsUrl(LINK_OPTIONS)
  instagram?: string;

  @IsOptional()
  @BlankToUndefined()
  @IsString()
  @MaxLength(MAX_LINK_LENGTH)
  @IsUrl(LINK_OPTIONS)
  youtube?: string;

  @IsOptional()
  @BlankToUndefined()
  @IsString()
  @MaxLength(MAX_LINK_LENGTH)
  @IsUrl(LINK_OPTIONS)
  spotify?: string;

  @IsOptional()
  @BlankToUndefined()
  @IsString()
  @MaxLength(MAX_LINK_LENGTH)
  @IsUrl(LINK_OPTIONS)
  tiktok?: string;

  @IsOptional()
  @BlankToUndefined()
  @IsString()
  @MaxLength(MAX_LINK_LENGTH)
  @IsUrl(LINK_OPTIONS)
  facebook?: string;

  @IsOptional()
  @BlankToUndefined()
  @IsString()
  @MaxLength(MAX_LINK_LENGTH)
  @IsUrl(LINK_OPTIONS)
  linkedin?: string;

  @IsOptional()
  @BlankToUndefined()
  @IsString()
  @MaxLength(MAX_LINK_LENGTH)
  @IsUrl(LINK_OPTIONS)
  twitter?: string;

  @IsOptional()
  @BlankToUndefined()
  @IsString()
  @MaxLength(MAX_LINK_LENGTH)
  @IsUrl(LINK_OPTIONS)
  website?: string;
}
