import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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
