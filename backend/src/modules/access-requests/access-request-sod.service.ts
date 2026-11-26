import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { IDENTITY_QUERY_PORT, IIdentityQueryPort } from '@shared/interfaces/identity-query.port';
import { toOperationType } from '@shared/utils/entitlement-operation-type';
import { systemKey } from '@shared/utils/normalize-system-name';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import {
  AccessRequest,
  type AccessRequestDocument,
  type AccessRequestEntitlement,
  type SodViolationRef,
} from './schemas/access-request.schema';
import {
  SodService,
  type SodProvisioningOp,
  type SodTarget,
  type SodViolation,
} from '../policy/sod.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { HELD_REQUEST_STATUSES, heldRequests } from './held-requests';

/** Loose shape returned by IdentityService.findById() (lean document). */
export interface IdentityLike {
  _id?: { toString(): string };
  tenantId?: string;
  profile?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    managerEmail?: string;
    departmentName?: string;
    departmentCode?: string;
    jobTitle?: string;
    employmentType?: string;
    location?: string;
    status?: string;
    sourceSystem?: string;
    sourceUserId?: string;
    [key: string]: unknown;
  };
  sources?: Array<{ sourceName?: string; externalId?: string }>;
  [key: string]: unknown;
}

/** An entitlement as the SoD check needs it: a catalog entry's system, native id and type. */
export type SodEntitlement = Pick<
  AccessRequestEntitlement,
  'system' | 'nativeId' | 'entitlementType'
>;

/**
 * Statuses claimForProvisioning claims: waiting for approvals, or PROVISIONING from an earlier
 * attempt of the same claim. Never CANCELLED or REJECTED.
 */
const CLAIMABLE_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'PROVISIONING'];

/** Policy operation types that are entitlements a person holds (what SoD policies name). */
const ENTITLEMENT_TYPES = new Set(['group', 'license', 'role']);

/** A violation as an access request stores it (`sodCheckResult.violations`). */
export function toViolationRefs(violations: SodViolation[]): SodViolationRef[] {
  return violations.map((v) => ({
    policyName: v.policyName,
    severity: v.severity,
    action: v.action,
    conflictingEntitlements: v.conflictingEntitlements.map((e) => `${e.system}:${e.targetId}`),
  }));
}

/** Requested or granted request entitlements as SoD operations (a directory role is `role`). */
function entitlementOperations(entitlements: SodEntitlement[]): SodProvisioningOp[] {
  return entitlements
    .filter((e) => e.nativeId)
    .map((e) => ({
      target: e.system,
      type: toOperationType(e.entitlementType),
      targetId: e.nativeId!,
      action: 'add' as const,
    }));
}

/**
 * SoD for access requests: what one person would hold with the requested entitlements, checked
 * against the tenant's active SoD policies (SodService.validate). What the person holds is their
 * birthright access from role-based rules (groups, licenses and directory roles, those that go to
 * a linked admin account included) and the entitlements of their other requests that are ACTIVE
 * and not past their expiry, or PROVISIONING and not stale (held-requests.ts). Pending requests do not count: claimForProvisioning
 * checks again when the last approval comes in. Entitlements are compared by their catalog native
 * id, so a rule or a policy naming a group by display name matches a request's native id.
 */
@Injectable()
export class AccessRequestSodService {
  private readonly logger = new Logger(AccessRequestSodService.name);

  constructor(
    @InjectModel(AccessRequest.name)
    private readonly accessRequestModel: Model<AccessRequestDocument>,
    private readonly sodService: SodService,
    private readonly policyEngine: PolicyEngineService,
    @Inject(IDENTITY_QUERY_PORT) private readonly identityQuery: IIdentityQueryPort,
    private readonly entitlementCatalog: EntitlementCatalogService,
  ) {}

  /**
   * Violations of giving `identityId` the `entitlements` on top of what they hold now: the
   * matches one of the `entitlements` is part of. A conflict the person already holds without
   * them does not count. The request `excludeRequestId` (the one being checked) is not counted
   * as held.
   */
  async check(
    tenantId: string,
    identityId: string,
    entitlements: SodEntitlement[],
    excludeRequestId?: string,
  ): Promise<{ blockers: SodViolation[]; warnings: SodViolation[] }> {
    const [birthright, requested] = await Promise.all([
      this.birthrightOperations(tenantId, identityId, { includeAdminOperations: true }),
      this.requestedAccessOperations(tenantId, identityId, excludeRequestId),
    ]);
    // Preventive: only a conflict the requested entitlements are part of refuses the request; one
    // the person already holds by itself is left to detective controls (hunt 04 F8)
    const asked = entitlementOperations(entitlements);
    const violations = await this.sodService.validate(
      tenantId,
      [...birthright, ...requested, ...asked],
      { involving: asked, resolveTargets: (targets) => this.catalogIds(tenantId, targets) },
    );
    return {
      blockers: violations.filter((v) => v.action === 'BLOCK'),
      warnings: violations.filter((v) => v.action === 'WARN'),
    };
  }

  /**
   * The `entitlements` of request `requestId` that `identityId` also holds another way: through
   * a role-based rule (birthright of the person's own account: what a rule gives the linked admin
   * account does not keep access on the account the revoke changes) or another request in
   * force (ACTIVE and not past its expiry, or PROVISIONING and not stale). Compared as the SoD check compares
   * them: system, operation type and catalog native id. Ending the request must not remove those.
   * A failed rule evaluation counts no birthright access (logged), so the revoke goes ahead.
   */
  async grantedElsewhere<T extends SodEntitlement>(
    tenantId: string,
    identityId: string,
    requestId: string,
    entitlements: T[],
  ): Promise<T[]> {
    const [birthright, requested] = await Promise.all([
      this.birthrightOperations(tenantId, identityId, { includeAdminOperations: false }),
      this.requestedAccessOperations(tenantId, identityId, requestId),
    ]);
    const held = [...birthright, ...requested];
    const own = entitlementOperations(entitlements);
    if (held.length === 0 || own.length === 0) return [];
    const target = (op: SodProvisioningOp): SodTarget => ({
      system: op.target,
      targetId: op.targetId,
    });
    const resolved = await this.catalogIds(tenantId, [...held, ...own].map(target));
    const keyOf = (op: SodProvisioningOp) => resolved(target(op)) ?? op.targetId;
    const heldElsewhere = (e: T) => {
      const [op] = entitlementOperations([e]);
      return (
        !!op &&
        held.some(
          (h) =>
            (systemKey(h.target) === 'all' || systemKey(h.target) === systemKey(op.target)) &&
            toOperationType(h.type) === op.type &&
            keyOf(h) === keyOf(op),
        )
      );
    };
    return entitlements.filter(heldElsewhere);
  }

  /**
   * The SoD check when the last approval of a request comes in, before fulfilment. The request is
   * first marked PROVISIONING, then checked against what the person holds at that moment, its
   * own entitlements left out. A BLOCK match marks it REJECTED with the matches as its
   * `sodCheckResult` (passed false) and returns passed false. Claiming before checking means
   * two requests for the two sides of a policy, approved at the same moment, each see the other
   * as being given: at least one is rejected, never are both fulfilled. A request an earlier
   * attempt rejected, or the requester cancelled, stays as it is and is not fulfilled.
   */
  async claimForProvisioning(tenantId: string, requestId: string): Promise<{ passed: boolean }> {
    const doc = await this.accessRequestModel.findOne({ tenantId, requestId }).lean().exec();
    if (!doc) return { passed: false };

    // Only a request still waiting for its approvals is claimed (or one this claim marked on an
    // attempt the activity retries): a request cancelled or rejected meanwhile stays as it is
    const claimed = await this.accessRequestModel
      .updateOne(
        { tenantId, requestId, status: { $in: CLAIMABLE_STATUSES } },
        { $set: { status: 'PROVISIONING' } },
      )
      .exec();
    if (claimed.matchedCount === 0) {
      this.logger.warn(`[AccessRequest] ${requestId} not fulfilled: it is no longer pending`);
      return { passed: false };
    }
    const identityId = doc.targetIdentityId ?? doc.requesterId;
    const { blockers, warnings } = await this.check(
      tenantId,
      identityId,
      doc.entitlements ?? [],
      requestId,
    );
    if (blockers.length === 0) return { passed: true };

    await this.accessRequestModel
      .updateOne(
        { tenantId, requestId },
        {
          $set: {
            status: 'REJECTED',
            sodCheckResult: {
              passed: false,
              violations: toViolationRefs([...blockers, ...warnings]),
            },
          },
        },
      )
      .exec();
    this.logger.warn(
      `[AccessRequest] ${requestId} rejected before fulfilment: SoD conflict with ` +
        blockers.map((v) => v.policyName).join(', '),
    );
    return { passed: false };
  }

  /**
   * Birthright access from role-based rules, evaluated on the profile onboarding and the mover
   * evaluate (every profile field and the HR contracts), so a rule on any attribute counts. With
   * `includeAdminOperations` the linked admin account's access counts too (SoD: what one person
   * holds across their accounts).
   */
  private async birthrightOperations(
    tenantId: string,
    identityId: string,
    options: { includeAdminOperations: boolean },
  ): Promise<SodProvisioningOp[]> {
    const profile = await this.identityQuery.findPolicyProfileById(identityId);
    if (!profile) return [];
    const user = identityToStandardUserDto(profile as IdentityLike);
    try {
      const operations = await this.policyEngine.evaluateOperationsWithoutSod(
        user,
        tenantId,
        options,
      );
      return operations
        .filter((op) => op.action === 'add' && ENTITLEMENT_TYPES.has(op.type))
        .map((op) => ({ target: op.target, type: op.type, targetId: op.targetId, action: 'add' }));
    } catch (err: unknown) {
      // As before: a failed evaluation checks the request against requested access only
      this.logger.warn(
        `[AccessRequest] Birthright access of identity ${identityId} not evaluated for SoD: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return [];
    }
  }

  /**
   * The catalog native id of each target: a rule names a group by its display name
   * (params.groupName), a request by its native id, an SoD policy by either. A target the catalog
   * does not know, or names twice on the system, keeps its own id.
   */
  private async catalogIds(
    tenantId: string,
    targets: SodTarget[],
  ): Promise<(target: SodTarget) => string | undefined> {
    const entryOf = await this.entitlementCatalog.loadTargetLookup(tenantId, targets);
    return (target) => entryOf(target)?.nativeId;
  }

  /**
   * Entitlements of the person's requests that are in force (ACTIVE and not past their expiry, or
   * PROVISIONING and not stale: heldRequests), `excludeRequestId` left out.
   */
  private async requestedAccessOperations(
    tenantId: string,
    identityId: string,
    excludeRequestId?: string,
  ): Promise<SodProvisioningOp[]> {
    const docs = await this.accessRequestModel
      .find({
        tenantId,
        status: { $in: HELD_REQUEST_STATUSES },
        $and: [
          // A request without targetIdentityId is for its requester
          {
            $or: [
              { targetIdentityId: identityId },
              { targetIdentityId: null, requesterId: identityId },
            ],
          },
          { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
        ],
        ...(excludeRequestId ? { requestId: { $ne: excludeRequestId } } : {}),
      })
      .select('entitlements requestId status updatedAt')
      .lean()
      .exec();
    return entitlementOperations(heldRequests(docs).flatMap((d) => d.entitlements ?? []));
  }
}

/**
 * The identity as the policy engine evaluates it for an access request: every field of the
 * profile (a flat profile, or the `profile` of an identity document), with the defaults the
 * engine needs where a field is missing. Hand-picking fields left out departmentName,
 * departmentCode, costCenter, contracts and the rest, so rules on them never matched (hunt 04 F2).
 */
export function identityToStandardUserDto(identity: IdentityLike): StandardUserDto {
  const profile = identity?.profile ?? identity;
  return {
    ...profile,
    tenantId: identity?.tenantId ?? getCurrentTenantId(),
    sourceSystem: profile?.sourceSystem ?? identity?.sources?.[0]?.sourceName ?? 'hr-feed',
    sourceUserId:
      profile?.sourceUserId ??
      identity?.sources?.[0]?.externalId ??
      identity?._id?.toString() ??
      profile?.email ??
      '',
    _id: identity?._id?.toString(),
    firstName: profile?.firstName ?? '',
    lastName: profile?.lastName ?? '',
    email: profile?.email ?? '',
    department: profile?.departmentName ?? profile?.departmentCode ?? '',
    jobTitle: profile?.jobTitle ?? '',
    employmentType: profile?.employmentType ?? 'FULL_TIME',
    location: profile?.location ?? '',
    status: profile?.status ?? 'ACTIVE',
    managerEmail: profile?.managerEmail,
  } as unknown as StandardUserDto;
}
