import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/** Mirrors the report_target_kind enum added in migration 024. */
export const REPORT_TARGET_KINDS = ['artist', 'planner', 'conversation'] as const;

export type ReportTargetKind = (typeof REPORT_TARGET_KINDS)[number];

export const SUPPORT_TICKET_STATUSES = [
  'open',
  'in_progress',
  'resolved',
  'closed',
] as const;

export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

export class CreateSupportTicketDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  subject: string;

  // A one-word body is almost always a mis-submit, and a ticket nobody can
  // action wastes a round trip asking what they meant.
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  body: string;

  // Required for guests, ignored for signed-in users — the service reads
  // the address from the account rather than trusting the body, so a
  // signed-in user cannot file a ticket under someone else's address.
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  guestEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  guestName?: string;

  // Normalised route, same rule as page_events.path — never a real URL,
  // and never a query string. It tells support which screen the person was
  // on without recording which specific artist they were looking at.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Matches(/^\/[A-Za-z0-9\-_/[\]().]*$/, {
    message: 'sourcePath must be a normalised route with no query string',
  })
  sourcePath?: string;

  // What this ticket is a report ABOUT, when it is one. Most tickets are
  // ordinary support requests and carry neither field.
  //
  // The two must arrive together or not at all — the database CHECK says the
  // same thing, and ValidateIf is what turns a constraint violation into a
  // message the caller can act on. A kind with no id is a report about
  // nothing; an id with no kind cannot be resolved to a table.
  @ValidateIf((o: CreateSupportTicketDto) => o.reportedId !== undefined)
  @IsIn(REPORT_TARGET_KINDS, { message: 'reportedKind must accompany reportedId.' })
  reportedKind?: ReportTargetKind;

  // Shape-validated rather than @IsUUID(), and deliberately so. The column is
  // UUID, so Postgres already rejects anything that is not one; what @IsUUID
  // adds on top is RFC version bits, which are stricter than the database and
  // reject ids Postgres accepts — the seeded demo accounts being the obvious
  // case. The id here comes from our own URLs, so shape is the right level.
  @ValidateIf((o: CreateSupportTicketDto) => o.reportedKind !== undefined)
  @Matches(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, {
    message: 'reportedId must accompany reportedKind, and be a UUID.',
  })
  reportedId?: string;
}

export class UpdateSupportTicketDto {
  @IsOptional()
  @IsIn(SUPPORT_TICKET_STATUSES)
  status?: SupportTicketStatus;

  @IsOptional()
  @IsUUID()
  assignedTo?: string;

  // A staff reply, appended to the thread.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  reply?: string;
}

export class ListSupportTicketsDto {
  @IsOptional()
  @IsIn(SUPPORT_TICKET_STATUSES)
  status?: SupportTicketStatus;
}
