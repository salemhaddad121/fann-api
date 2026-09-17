export type UserRole   = 'artist' | 'planner' | 'admin';

/**
 * Individual vs company, for a booker. Null until answered — existing
 * bookers predate the question and are prompted rather than locked out.
 */
export type PlannerKind = 'individual' | 'company';

/**
 * What a booker said they were looking for at signup. Multi-select.
 *
 * A booker-facing axis, deliberately not the artist-facing category_groups:
 * artists classify by craft and bookers search by need, and a DJ is a
 * musician to himself and a service to a venue.
 */
export type BookerInterest =
  | 'musical_acts'
  | 'performance_acts'
  | 'photo_video'
  | 'djs_and_services'
  // A booker looking for a room is looking for something. Venues register
  // free on the artist side precisely so bookers can find them, so the
  // interest a booker states at signup has to be able to say so.
  | 'venues';
export type UserStatus = 'pending_review' | 'active' | 'suspended' | 'banned';

export interface UserRecord {
  id: string;
  email: string;
  phone: string | null;
  passwordHash: string | null;
  role: UserRole;
  status: UserStatus;
  accountCode: string;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  createdAt: Date;
  deletedAt: Date | null;
  // Set while an email change is awaiting confirmation (see
  // requestEmailChange/verifyEmail in auth.service.ts). The active
  // `email` above keeps working for login until this is confirmed.
  pendingEmail: string | null;
}
