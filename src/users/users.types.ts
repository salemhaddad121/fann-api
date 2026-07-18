export type UserRole   = 'artist' | 'planner' | 'admin';
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
}
