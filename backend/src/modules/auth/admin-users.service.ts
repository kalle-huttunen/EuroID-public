import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { AdminUserRoleChangedPayload } from '@infrastructure/events/event-payloads';
import { AdminRole, AdminUser, AdminUserDocument } from './schemas/admin-user.schema';
import type { AdminUserSafe } from './auth-local.service';

/** What the admin routes check about their target before they act. */
export interface AdminInTenant {
  role: string;
  isActive: boolean;
  authSource: string;
}

const LAST_SUPER_ADMIN =
  'This is the last active super-admin of the tenant. Make another admin a super-admin first.';

/** An admin counts as active unless deactivated (accounts stored before isActive count too). */
const ACTIVE = { isActive: { $ne: false } };

type StoredAdmin = Pick<AdminUser, 'email' | 'name' | 'role' | 'tenantId' | 'isActive'> & {
  _id: unknown;
};

function toSafe(admin: StoredAdmin): AdminUserSafe {
  return {
    id: String(admin._id),
    email: admin.email,
    name: admin.name,
    role: admin.role,
    tenantId: admin.tenantId,
  };
}

/**
 * Tenant super-admins managing their own tenant's admins: the lookup the admin routes do first,
 * role changes, deactivation and reactivation. AdminUser is exempt from the tenant plugin, so
 * every filter names the tenant.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    @InjectModel(AdminUser.name) private readonly adminModel: Model<AdminUserDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** The admin of `tenantId` with this id; null for another tenant's admin or an unknown id. */
  async findInTenant(userId: string, tenantId: string): Promise<AdminInTenant | null> {
    const admin = await this.adminModel
      .findOne({ _id: userId, tenantId }, 'role isActive authSource')
      .lean<Partial<AdminUser>>();
    if (!admin) return null;
    return {
      role: admin.role ?? 'viewer',
      isActive: admin.isActive !== false,
      authSource: admin.authSource ?? 'local',
    };
  }

  /** The admin of `tenantId` as the admin routes answer it; null as findInTenant. */
  async safeInTenant(userId: string, tenantId: string): Promise<AdminUserSafe | null> {
    const admin = await this.adminModel
      .findOne({ _id: userId, tenantId }, 'email name role tenantId isActive')
      .lean<StoredAdmin>();
    return admin ? toSafe(admin) : null;
  }

  /**
   * Give an admin of `tenantId` another tenant role (null when there is no such admin). The
   * caller refuses your own account and a platform admin's before this runs. Refused (409) when
   * it would leave the tenant without an active super-admin. JwtAuthGuard reads the role from the
   * database on every request, so it applies from the admin's next request; sessions stay.
   *
   * No transaction (MongoDB runs without a replica set): two super-admins demoting each other at
   * once both pass the first check, so the count is taken again after the write, and a change
   * that left no active super-admin is put back and refused.
   */
  async changeRole(
    userId: string,
    role: AdminRole,
    tenantId: string,
    changedBy: string,
  ): Promise<AdminUserSafe | null> {
    const admin = await this.adminModel
      .findOne({ _id: userId, tenantId }, 'email name role tenantId isActive')
      .lean<StoredAdmin>();
    if (!admin) return null;
    const previousRole = admin.role ?? 'viewer';
    if (previousRole === role) return toSafe(admin);

    const demotesActiveOwner = previousRole === 'super-admin' && admin.isActive !== false;
    if (demotesActiveOwner && !(await this.hasActiveSuperAdmin(tenantId, userId))) {
      throw new ConflictException(LAST_SUPER_ADMIN);
    }
    const updated = await this.adminModel
      .findOneAndUpdate(
        { _id: userId, tenantId, role: previousRole },
        { $set: { role } },
        { new: true, projection: 'email name role tenantId isActive' },
      )
      .lean<StoredAdmin>();
    if (!updated) {
      throw new ConflictException(
        'The admin was changed meanwhile. Reload the list and try again.',
      );
    }
    if (demotesActiveOwner && !(await this.hasActiveSuperAdmin(tenantId))) {
      await this.adminModel.updateOne(
        { _id: userId, tenantId, role },
        { $set: { role: previousRole } },
      );
      this.logger.warn(`Role change of admin ${userId} put back: no active super-admin was left`);
      throw new ConflictException(LAST_SUPER_ADMIN);
    }

    const payload: AdminUserRoleChangedPayload = {
      adminUserId: userId,
      previousRole,
      newRole: role,
      changedBy,
    };
    this.eventEmitter.emit(DomainEventType.ADMIN_USER_ROLE_CHANGED, userId, payload, { tenantId });
    return toSafe(updated);
  }

  /**
   * Deactivate (every session ends) or reactivate an admin of `tenantId`; null when there is no
   * such admin. The caller refuses your own account and a platform admin's first. Deactivating
   * the tenant's last active super-admin is refused (409): an OIDC super-admin or the break-glass
   * token has no account of its own for the self check to stop. As in changeRole, the count is
   * taken again after the write, so of two super-admins deactivating each other at once at least
   * one stays active; the one put back keeps its account but its sessions have ended.
   */
  async setActive(
    userId: string,
    isActive: boolean,
    tenantId: string,
  ): Promise<AdminUserSafe | null> {
    const fields = 'email name role tenantId isActive';
    const admin = await this.adminModel
      .findOne({ _id: userId, tenantId }, fields)
      .lean<StoredAdmin>();
    if (!admin) return null;
    if (isActive) {
      const reactivated = await this.adminModel
        .findOneAndUpdate(
          { _id: userId, tenantId },
          { $set: { isActive: true } },
          { new: true, projection: fields },
        )
        .lean<StoredAdmin>();
      return reactivated ? toSafe(reactivated) : null;
    }

    const deactivatesOwner = admin.role === 'super-admin' && admin.isActive !== false;
    if (deactivatesOwner && !(await this.hasActiveSuperAdmin(tenantId, userId))) {
      throw new ConflictException(LAST_SUPER_ADMIN);
    }
    const updated = await this.adminModel
      .findOneAndUpdate(
        { _id: userId, tenantId },
        {
          $set: { isActive: false },
          $inc: { tokenVersion: 1 },
          $unset: { refreshTokenHash: 1, refreshTokenExpiresAt: 1 },
        },
        { new: true, projection: fields },
      )
      .lean<StoredAdmin>();
    if (!updated) return null;
    if (deactivatesOwner && !(await this.hasActiveSuperAdmin(tenantId))) {
      await this.adminModel.updateOne({ _id: userId, tenantId }, { $set: { isActive: true } });
      this.logger.warn(`Deactivation of admin ${userId} put back: no active super-admin was left`);
      throw new ConflictException(LAST_SUPER_ADMIN);
    }
    return toSafe(updated);
  }

  /** Whether the tenant has an active super-admin, other than `exceptId` when given. */
  private async hasActiveSuperAdmin(tenantId: string, exceptId?: string): Promise<boolean> {
    const filter = {
      tenantId,
      role: 'super-admin',
      ...ACTIVE,
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    };
    return (await this.adminModel.exists(filter)) !== null;
  }
}
