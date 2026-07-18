import { UserRole, UserStatus } from '../../users/users.types';

export interface JwtPayload {
  sub: string;         // user UUID
  email: string;
  role: UserRole;
  status: UserStatus;
  accountCode: string;
  iat?: number;
  exp?: number;
}
