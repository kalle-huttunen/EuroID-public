import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AdminUser, AdminUserDocument } from '../auth/schemas/admin-user.schema';
import { IDENTITY_QUERY_PORT, IIdentityQueryPort } from '@shared/interfaces/identity-query.port';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';

/** Loose check that a key is an email address rather than an id or a role name. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A 24-hex ObjectId string (Types.ObjectId.isValid also accepts any 12-character string). */
const OBJECT_ID = /^[a-f0-9]{24}$/i;

function emailOf(user: Record<string, unknown> | null): string | null {
  const email = user?.email;
  return typeof email === 'string' && email.trim() ? email.trim() : null;
}

/**
 * Turns the approver, reviewer or owner a record names into an address, inside one tenant only.
 * A key resolves when it names an active admin user of the tenant (by email or id) or a
 * not-deleted identity of the tenant (by email or id). Anything else (an address nobody in the
 * tenant has, a role name, the "unassigned" placeholder reviewer) resolves to null and gets no mail.
 * A ROLE approval step goes to `roleHolders` instead.
 */
@Injectable()
export class EmailRecipientsService {
  constructor(
    @InjectModel(AdminUser.name) private readonly adminUsers: Model<AdminUserDocument>,
    @Inject(IDENTITY_QUERY_PORT) private readonly identities: IIdentityQueryPort,
  ) {}

  /** Address of the user `key` (an email or an id) names in `tenantId`, or null. */
  async resolve(tenantId: string, key: string | undefined | null): Promise<string | null> {
    const k = key?.trim();
    if (!k) return null;
    // AdminUser skips the tenant plugin: the tenant is always in the filter.
    if (EMAIL_SHAPE.test(k)) {
      const admin = await this.adminUsers
        .findOne({ tenantId, email: k.toLowerCase(), isActive: true })
        .select('email')
        .lean()
        .exec();
      if (admin?.email) return admin.email;
      return withTenantContext(tenantId, async () => emailOf(await this.identities.findByEmail(k)));
    }
    if (OBJECT_ID.test(k)) {
      const admin = await this.adminUsers
        .findOne({ _id: k, tenantId, isActive: true })
        .select('email')
        .lean()
        .exec();
      if (admin?.email) return admin.email;
      return withTenantContext(tenantId, async () => emailOf(await this.identities.findById(k)));
    }
    return null;
  }

  /** Addresses of the active admin users of `tenantId` whose role is `role` (a ROLE approval step). */
  async roleHolders(tenantId: string, role: string): Promise<string[]> {
    const admins = await this.adminUsers
      .find({ tenantId, role, isActive: true })
      .select('email')
      .sort({ email: 1 })
      .lean()
      .exec();
    return admins
      .map((admin) => admin.email?.trim())
      .filter((email): email is string => Boolean(email));
  }

  /** Address of the identity that holds the access (its owner), or null. */
  async identityEmail(tenantId: string, identityId: string): Promise<string | null> {
    if (!OBJECT_ID.test(identityId)) return null;
    return withTenantContext(tenantId, async () =>
      emailOf(await this.identities.findById(identityId)),
    );
  }
}
