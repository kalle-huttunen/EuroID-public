import {
  Inject,
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type {
  IdentityDocument,
  LinkedAdminAccount,
  IdentityProfile,
} from '../identity/schemas/identity.schema';
import { Identity } from '../identity/schemas/identity.schema';
import { maskEmail } from '../identity/identity-pii';
import { NOT_DELETED } from '../identity/identity.constants';
import { findLiveLinkedAdmins, type LiveLinkedAdmin } from '../identity/linked-admin-identities';

/** Lean representation of an Identity document (from .lean()). */
interface IdentityLean {
  _id: { toString(): string };
  tenantId: string;
  profile: IdentityProfile;
  linkedAdminAccounts?: LinkedAdminAccount[];
  parentIdentityId?: string;
  adminTier?: string;
  provisioning?: Array<{ targetSystem: string; status?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
import { IdentityService } from '../identity/identity.service';
import { EmploymentType, UserStatus } from '@shared/dtos/standard-user.dto';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { type PamConfig, pamConfig } from '@infrastructure/config/pam.config';
import { adminUpn, withNumericSuffix } from './admin-upn';
import {
  PrivilegedSessionService,
  type AdminActivationResult,
  type AdminDeactivationResult,
} from './privileged-session.service';
import { PAM_SOURCE_SYSTEM } from '@shared/utils/linked-admin-profile';
import type { PamOktaStatusReader } from '@shared/types/pam-session';

@Injectable()
export class PrivilegedAccessService {
  private readonly logger = this.loggerFactory.create(PrivilegedAccessService.name);
  private readonly pamMaxSessionHours: Record<string, number>;

  constructor(
    @InjectModel(Identity.name) private readonly identityModel: Model<IdentityDocument>,
    private readonly identityService: IdentityService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly loggerFactory: LoggerFactoryService,
    @Inject(pamConfig.KEY) private readonly pamConf: PamConfig,
    private readonly sessions: PrivilegedSessionService,
  ) {
    this.pamMaxSessionHours = {
      TIER_0: this.pamConf.tier0MaxHours,
      TIER_1: this.pamConf.tier1MaxHours,
      TIER_2: this.pamConf.tier2MaxHours,
    };
  }

  /**
   * The admin UPN for the person's tier (adminUpn: ADMIN_UPN_PATTERN, names in ASCII), free among
   * live identities. Another person's identity holding it gives the next numeric suffix
   * (adm-ada.lovelace2@...), up to ADMIN_UPN_MAX_SUFFIX. The person's own admin account of
   * another tier holding it is a 409: the pattern has no `{tier}`, so the person cannot have a
   * second admin account. Messages name no address: the activity's failure reaches workflow
   * history in clear.
   */
  private async freeAdminUpn(
    parentIdentityId: string,
    adminTier: string,
    profile: { firstName?: string; lastName?: string; email: string },
    tenantId: string,
  ): Promise<string> {
    const base = adminUpn(this.pamConf.adminUpnPattern, { ...profile, adminTier });
    const maxSuffix = this.pamConf.adminUpnMaxSuffix;
    for (let n = 1; n <= maxSuffix; n++) {
      const candidate = n === 1 ? base : withNumericSuffix(base, n);
      // Live identities only, as the unique email index: a former employee's address is free
      const holder = await this.identityModel
        .findOne({ tenantId, 'profile.email': candidate, ...NOT_DELETED })
        .exec();
      if (!holder) return candidate;
      const otherTier = holder.parentIdentityId
        ? String(holder.parentIdentityId) === parentIdentityId
        : false;
      if (otherTier) {
        throw new ConflictException(
          `The ${adminTier} admin account cannot be created: ADMIN_UPN_PATTERN gives it the UPN ` +
            `of this person's ${holder.adminTier ?? 'other'} admin account. Add {tier} to ` +
            'ADMIN_UPN_PATTERN (for example adm-{firstName}.{lastName}-{tier}@{domain}) to give ' +
            'a person one admin account per tier.',
        );
      }
    }
    throw new ConflictException(
      `The ${adminTier} admin account cannot be created: live identities hold the UPN ` +
        `ADMIN_UPN_PATTERN gives it and its numeric suffixes up to ${maxSuffix} ` +
        '(ADMIN_UPN_MAX_SUFFIX).',
    );
  }

  /**
   * Create a linked admin identity for a parent identity. Idempotent: returns existing if one exists for this tier.
   */
  async createLinkedAdminIdentity(
    parentIdentityId: string,
    adminTier: string,
    tenantId?: string,
  ): Promise<IdentityDocument> {
    const tid = tenantId ?? getRequestContext()?.tenantId ?? getCurrentTenantId();
    // A deleted (offboarded) parent gets no new privileged account
    const parent = await this.identityModel
      .findOne({ _id: parentIdentityId, tenantId: tid, ...NOT_DELETED })
      .exec();
    if (!parent?.profile?.email) {
      throw new NotFoundException(`Parent identity ${parentIdentityId} not found`);
    }

    const profile = parent.profile as { firstName?: string; lastName?: string; email?: string };
    const firstName = profile.firstName ?? 'Admin';
    const lastName = profile.lastName ?? 'User';
    const parentEmail = profile.email ?? '';

    // The tier's admin identity, if one is live: a deleted one (offboarded) holds no account, so
    // a new one is created. Its entry stays, so every entry of the tier is looked at.
    const existing = parent.linkedAdminAccounts as LinkedAdminAccount[] | undefined;
    const tierIds = (existing ?? [])
      .filter((la) => la.adminTier === adminTier)
      .map((la) => la.identityId);
    if (tierIds.length > 0) {
      const adminIdentity = await this.identityModel
        .findOne({ _id: { $in: tierIds }, tenantId: tid, ...NOT_DELETED })
        .exec();
      if (adminIdentity) {
        this.logger.log(`Linked admin for tier ${adminTier} already exists: ${adminIdentity._id}`);
        return adminIdentity;
      }
    }

    const adminEmail = await this.freeAdminUpn(
      parentIdentityId,
      adminTier,
      { firstName, lastName, email: parentEmail },
      tid,
    );

    const adminIdentity = await this.identityModel.create({
      tenantId: tid,
      profile: {
        firstName,
        lastName,
        email: adminEmail,
        userPrincipalName: adminEmail,
        employmentType: EmploymentType.ADMIN_ACCOUNT,
        status: UserStatus.PENDING,
        // With ADMIN_ACCOUNT: the connectors create its accounts disabled (linked-admin-profile.ts)
        sourceSystem: PAM_SOURCE_SYSTEM,
        sourceUserId: `${parentIdentityId}-${adminTier}`,
      },
      sources: [],
      controls: {},
      provisioning: [],
      parentIdentityId,
      adminTier,
    });

    const linkedEntry: LinkedAdminAccount = {
      identityId: adminIdentity._id.toString(),
      adminTier,
      status: 'PENDING',
    };

    await this.identityModel.findOneAndUpdate(
      { _id: parentIdentityId, tenantId: tid },
      { $push: { linkedAdminAccounts: linkedEntry } },
    );

    // The admin identity is the aggregate; no admin UPN (audit log, websocket, webhooks)
    this.eventEmitter.emit(
      DomainEventType.ADMIN_ACCOUNT_CREATED,
      adminIdentity._id.toString(),
      { parentIdentityId, adminTier },
      { actor: 'privileged-access-service' },
    );

    this.logger.log(
      `Created linked admin identity ${maskEmail(adminEmail)} for parent ${parentIdentityId}`,
    );
    return adminIdentity;
  }

  /**
   * Start a privileged session (privilegedSessionWorkflow): it enables the admin identity's
   * accounts in the target systems for the tier's PAM_TIER*_MAX_HOURS. Answers ACTIVE (with
   * `expiresAt`) once they are enabled, ACTIVATING while the wait (PAM_ACTIVATION_WAIT_MS) is not
   * enough, 502 with the reason when enabling failed (nothing stays enabled), 409 while a session
   * of it runs (PrivilegedSessionService.activate).
   */
  async activateAdminAccount(
    adminIdentityId: string,
    requesterIdentityId?: string,
    requesterRoles?: string[],
  ): Promise<AdminActivationResult> {
    const tenantId = getRequestContext()?.tenantId || getCurrentTenantId();
    // Activation grants privileged access: a deleted (offboarded) admin identity is not found
    const admin = await this.identityModel
      .findOne({ _id: adminIdentityId, tenantId, ...NOT_DELETED })
      .exec();
    if (!admin?.parentIdentityId) {
      throw new NotFoundException(
        `Admin identity ${adminIdentityId} not found or not a linked admin`,
      );
    }

    const isInternalCall = requesterIdentityId === undefined && requesterRoles === undefined;
    const parentId = admin.parentIdentityId.toString();
    const isParent = requesterIdentityId && parentId === requesterIdentityId;
    const hasAdminOverride =
      requesterRoles?.includes('super-admin') || requesterRoles?.includes('connector-admin');
    if (!isInternalCall && !isParent && !hasAdminOverride) {
      throw new ForbiddenException(
        'Only the parent identity can activate their admin account, or a connector-admin/super-admin',
      );
    }

    // The person the account belongs to must still exist (not offboarded, not erased)
    const liveParent = await this.identityModel
      .findOne({ _id: parentId, tenantId, ...NOT_DELETED })
      .select('_id')
      .lean()
      .exec();
    if (!liveParent) {
      throw new ConflictException(
        `Admin account ${adminIdentityId} cannot be activated: its parent identity ${parentId} ` +
          'is deleted. Deactivate it instead.',
      );
    }

    // The session enables the accounts, then records ACTIVE (privilegedSessionWorkflow)
    const tier = admin.adminTier ?? 'TIER_2';
    const maxHours = this.pamMaxSessionHours[tier] ?? this.pamMaxSessionHours.TIER_2;
    return this.sessions.activate(adminIdentityId, parentId, maxHours * 60 * 60 * 1000, tenantId);
  }

  /**
   * End the privileged session: a running session is signalled; with none running a
   * disable-only run starts, so the accounts end disabled in the target systems either way.
   * Works on any admin identity (a deleted one, one of a deleted parent): taking access away
   * stays open. Answers INACTIVE (or PENDING) once the entry left ACTIVE and ACTIVATING,
   * DEACTIVATING while the wait is not enough. The provisioning entries stay (offboarding reads
   * them).
   */
  async deactivateAdminAccount(
    adminIdentityId: string,
    requesterIdentityId?: string,
    requesterRoles?: string[],
  ): Promise<AdminDeactivationResult> {
    const tenantId = getRequestContext()?.tenantId || getCurrentTenantId();
    const admin = await this.identityModel.findOne({ _id: adminIdentityId, tenantId }).exec();
    if (!admin?.parentIdentityId) {
      throw new NotFoundException(
        `Admin identity ${adminIdentityId} not found or not a linked admin`,
      );
    }

    const isInternalCall = requesterIdentityId === undefined && requesterRoles === undefined;
    const parentId = admin.parentIdentityId.toString();
    const isParent = requesterIdentityId && parentId === requesterIdentityId;
    const hasAdminOverride =
      requesterRoles?.includes('super-admin') || requesterRoles?.includes('connector-admin');
    if (!isInternalCall && !isParent && !hasAdminOverride) {
      throw new ForbiddenException(
        'Only the parent identity can deactivate their admin account, or a connector-admin/super-admin',
      );
    }

    return this.sessions.deactivate(adminIdentityId, parentId, tenantId, 'deactivated');
  }

  async getLinkedAdminAccounts(
    parentIdentityId: string,
    requesterIdentityId?: string,
    requesterRoles?: string[],
  ): Promise<LinkedAdminAccount[]> {
    const tenantId = getRequestContext()?.tenantId || getCurrentTenantId();
    const parent = await this.identityModel
      .findOne({ _id: parentIdentityId, tenantId, ...NOT_DELETED })
      .exec();
    if (!parent) throw new NotFoundException(`Parent identity ${parentIdentityId} not found`);

    const isOwn = requesterIdentityId && parentIdentityId === requesterIdentityId;
    const hasOperatorRole =
      requesterRoles?.includes('operator') ||
      requesterRoles?.includes('connector-admin') ||
      requesterRoles?.includes('policy-admin') ||
      requesterRoles?.includes('super-admin');
    if (!isOwn && !hasOperatorRole) {
      throw new ForbiddenException(
        'You can only view linked admin accounts for your own identity, or as an operator',
      );
    }
    // A deleted admin identity's entry stays on the parent (createLinkedAdminIdentity): leave it out
    const entries = parent.linkedAdminAccounts ?? [];
    if (entries.length === 0) return [];
    const live = await this.identityModel
      .find({ _id: { $in: entries.map((la) => la.identityId) }, tenantId, ...NOT_DELETED })
      .select('_id')
      .lean()
      .exec();
    const liveIds = new Set(live.map((doc) => String(doc._id)));
    return entries.filter((la) => liveIds.has(la.identityId));
  }

  /**
   * The parent's live linked admin identities, which offboarding the parent offboards first: the
   * identities whose `parentIdentityId` is the parent and those its `linkedAdminAccounts` entries
   * name, not deleted, in this tenant, oldest first, each with its email (its UPN).
   */
  async findLiveLinkedAdmins(
    parentIdentityId: string,
    tenantId: string,
  ): Promise<LiveLinkedAdmin[]> {
    return findLiveLinkedAdmins(this.identityModel, parentIdentityId, tenantId);
  }

  /**
   * The hourly expiry sweep's safety net for sessions: each ACTIVE entry whose `expiresAt` has
   * passed gets its session ended, as a deactivation (the session's own timer normally ends it
   * first). Returns how many.
   */
  async deactivateExpiredSessions(tenantId: string): Promise<number> {
    return this.sessions.endExpired(tenantId, new Date());
  }

  /**
   * The hourly sweep: disable-only runs for live admin identities whose accounts may still be
   * enabled outside a session (PrivilegedSessionService.convergeStandingState). `readOktaStatus`
   * lets it leave alone an Okta account still waiting for its owner's activation.
   */
  async convergeStandingState(
    tenantId: string,
    readOktaStatus?: PamOktaStatusReader,
  ): Promise<number> {
    return this.sessions.convergeStandingState(tenantId, readOktaStatus);
  }

  /** After admin account provisioning (PrivilegedSessionService.settleAfterProvisioning). */
  async settleAfterProvisioning(adminIdentityId: string, tenantId: string): Promise<boolean> {
    return this.sessions.settleAfterProvisioning(adminIdentityId, tenantId);
  }

  /**
   * List all admin accounts across identities (for dashboard).
   */
  async listAllAdminAccounts(tenantId?: string): Promise<
    Array<{
      adminIdentityId: string;
      adminEmail: string;
      parentIdentityId: string;
      parentEmail: string;
      adminTier: string;
      /** The session: PENDING, ACTIVATING, ACTIVE (until `expiresAt`) or INACTIVE. */
      status: string;
      activatedAt?: Date;
      expiresAt?: Date;
      /** Why the last activation failed (nothing stayed enabled). */
      activationError?: string;
      /** Why disabling the accounts failed (they may still be enabled; retried hourly). */
      disableError?: string;
      /** The parent identity is deleted or gone: the account cannot be activated, only deactivated. */
      parentDeleted: boolean;
    }>
  > {
    const tid = tenantId ?? getCurrentTenantId();
    // Deleted (offboarded) admin identities are left out; a live one of a deleted parent stays
    // listed, marked, so its session can still be ended
    const admins = await this.identityModel
      .find({ tenantId: tid, parentIdentityId: { $exists: true, $ne: null }, ...NOT_DELETED })
      .select('_id profile.email parentIdentityId adminTier')
      .lean()
      .exec();

    const parentIds = [
      ...new Set(
        admins
          .map((a) => (a as unknown as IdentityLean).parentIdentityId)
          .filter((id): id is string => !!id),
      ),
    ];
    const parents = await this.identityModel
      .find({ _id: { $in: parentIds }, tenantId: tid })
      .select('_id profile.email linkedAdminAccounts deletedAt')
      .lean()
      .exec();

    const parentMap = new Map(parents.map((p) => [p._id.toString(), p as unknown as IdentityLean]));

    return admins.map((admin) => {
      const a = admin as unknown as IdentityLean;
      const parent = parentMap.get(a.parentIdentityId!);
      const linked = (parent?.linkedAdminAccounts ?? []).find(
        (la) => la.identityId === a._id.toString(),
      );
      return {
        adminIdentityId: a._id.toString(),
        adminEmail: a.profile?.email ?? '',
        parentIdentityId: a.parentIdentityId!,
        parentEmail: parent?.profile?.email ?? '',
        adminTier: a.adminTier ?? '',
        status: linked?.status ?? 'PENDING',
        activatedAt: linked?.activatedAt,
        expiresAt: linked?.expiresAt,
        activationError: linked?.activationError,
        disableError: linked?.disableError,
        parentDeleted: !parent || !!parent.deletedAt,
      };
    });
  }
}
