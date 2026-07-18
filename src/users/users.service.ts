import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from 'nest-knexjs';
import { Knex } from 'knex';
import { aggregateValue } from '../common/db.util';
import { UserRecord, UserRole, UserStatus } from './users.types';

@Injectable()
export class UsersService {
  constructor(@InjectConnection() private readonly db: Knex) {}

  // ----------------------------------------------------------------
  // Lookups
  // ----------------------------------------------------------------
  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.db('users').where({ id }).first();
    return row ? this.toRecord(row) : null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.db('users').where({ email }).first();
    return row ? this.toRecord(row) : null;
  }

  async findByOAuth(provider: string, providerUid: string): Promise<UserRecord | null> {
    const row = await this.db('oauth_accounts as oa')
      .join('users as u', 'u.id', 'oa.user_id')
      .where({ 'oa.provider': provider, 'oa.provider_uid': providerUid })
      .select('u.*')
      .first();
    return row ? this.toRecord(row) : null;
  }

  // ----------------------------------------------------------------
  // Public info — the minimum needed to show "who is this" for a bare
  // user id, without exposing email/phone/status. Closes a gap hit
  // repeatedly by messaging, bookings, and the dropped profile link:
  // none of those flows had any way to resolve a user id to a name.
  // ----------------------------------------------------------------
  async getPublicInfo(userId: string) {
    const user = await this.db('users').where({ id: userId }).select('id', 'role').first();
    if (!user) throw new NotFoundException('User not found.');

    if (user.role === 'admin') {
      return { id: userId, role: 'admin', displayName: null, thumbnailUrl: null, profileId: null };
    }

    const table = user.role === 'artist' ? 'artist_profiles' : 'planner_profiles';
    const profile = await this.db(table)
      .where({ user_id: userId })
      .select('id', 'display_name', 'thumbnail_url')
      .first();

    return {
      id: userId,
      role: user.role,
      displayName: profile?.display_name ?? null,
      thumbnailUrl: profile?.thumbnail_url ?? null,
      // The id frontend routes need for /artists/[id] or /planners/[id] —
      // distinct from the user id, since those routes are profile-id keyed.
      profileId: profile?.id ?? null,
    };
  }

  // ----------------------------------------------------------------
  // Create
  // ----------------------------------------------------------------
  async create(data: {
    email: string;
    passwordHash: string | null;
    role: UserRole;
    phone?: string;
  }): Promise<UserRecord> {
    const existing = await this.findByEmail(data.email);
    if (existing) throw new ConflictException('An account with this email already exists.');

    const accountCode = await this.generateAccountCode(data.role);

    const [row] = await this.db('users')
      .insert({
        email:         data.email,
        phone:         data.phone ?? null,
        password_hash: data.passwordHash,
        role:          data.role,
        status:        'pending_review' as UserStatus,
        account_code:  accountCode,
      })
      .returning('*');

    return this.toRecord(row);
  }

  async linkOAuthAccount(userId: string, provider: string, providerUid: string): Promise<void> {
    await this.db('oauth_accounts')
      .insert({ user_id: userId, provider, provider_uid: providerUid })
      .onConflict(['provider', 'provider_uid'])
      .ignore();
  }

  // ----------------------------------------------------------------
  // Updates
  // ----------------------------------------------------------------
  async markEmailVerified(userId: string): Promise<void> {
    await this.db('users')
      .where({ id: userId })
      .update({ email_verified_at: this.db.fn.now() });
  }

  async markPhoneVerified(userId: string): Promise<void> {
    await this.db('users')
      .where({ id: userId })
      .update({ phone_verified_at: this.db.fn.now() });
  }

  async updatePhone(userId: string, phone: string): Promise<void> {
    await this.db('users').where({ id: userId }).update({ phone });
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await this.db('users').where({ id: userId }).update({ password_hash: passwordHash });
  }

  // Records the requested new address without touching the active email —
  // login and everything else keeps using the current email until the
  // change is confirmed via the verification link (applyPendingEmail below).
  async setPendingEmail(userId: string, newEmail: string): Promise<void> {
    await this.db('users').where({ id: userId }).update({ pending_email: newEmail });
  }

  // Called once the verification link for an email change is confirmed —
  // promotes pending_email to the real email and marks it verified in one
  // step, atomically (a partially-applied state, e.g. email swapped but
  // still shown unverified, would be confusing and wrong).
  //
  // newEmail is passed in explicitly (read fresh from the DB by the
  // caller) rather than re-read here, so this only ever writes the value
  // the caller already confirmed is still the pending one.
  async applyPendingEmail(userId: string, newEmail: string): Promise<void> {
    try {
      await this.db('users')
        .where({ id: userId })
        .update({
          email: newEmail,
          pending_email: null,
          email_verified_at: this.db.fn.now(),
        });
    } catch (err: any) {
      // Postgres unique_violation — someone else claimed this exact email
      // (as their active address) in the window between the request and
      // this confirmation.
      if (err?.code === '23505') {
        throw new ConflictException('That email is already in use by another account.');
      }
      throw err;
    }
  }

  // Soft delete — see migration 007's comment for why this reuses
  // 'banned' rather than removing the row or adding a new status value.
  // Email is anonymized so the address can be reused for a new signup,
  // and so it stops appearing in plain text in exports/support tools.
  async softDeleteAccount(userId: string): Promise<void> {
    await this.db('users')
      .where({ id: userId })
      .update({
        status: 'banned' as UserStatus,
        deleted_at: this.db.fn.now(),
        email: this.db.raw(`'deleted-' || id || '@deleted.aynu.local'`),
      });
  }

  async updateStatus(userId: string, status: UserStatus): Promise<void> {
    await this.db('users').where({ id: userId }).update({ status });
  }

  async updateLastLogin(userId: string): Promise<void> {
    await this.db('users')
      .where({ id: userId })
      .update({ last_login_at: this.db.fn.now() });
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------
  private async generateAccountCode(role: UserRole): Promise<string> {
    const prefix = role === 'artist' ? 'ART' : role === 'planner' ? 'PLN' : 'ADM';

    // Count existing accounts of this role and pad to 6 digits
    const countRow = await this.db('users')
      .where({ role })
      .count('id as count')
      .first();

    const seq = String(aggregateValue(countRow, 'count') + 1).padStart(6, '0');
    return `${prefix}-${seq}`;
  }

  private toRecord(row: any): UserRecord {
    return {
      id:              row.id,
      email:           row.email,
      phone:           row.phone,
      passwordHash:    row.password_hash,
      role:            row.role,
      status:          row.status,
      accountCode:     row.account_code,
      emailVerifiedAt: row.email_verified_at,
      phoneVerifiedAt: row.phone_verified_at,
      createdAt:       row.created_at,
      deletedAt:       row.deleted_at,
      pendingEmail:    row.pending_email,
    };
  }
}
