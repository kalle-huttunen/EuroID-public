/**
 * The access identities hold, for peer groups and recommendations: resolved as the identity page
 * resolves it (IdentityEntitlementsService, GET /identity/:id/entitlements) and as the access
 * explorer resync loads it (GraphResyncService). The group, license and role grants the active
 * policies give the identity (the SoD-free evaluation of its policy profile) follow its account in
 * the target system: Active when SYNCED (resolveStatus). The entitlements of its ACTIVE and
 * PROVISIONING access requests (the identity as beneficiary) follow the request: Active when ACTIVE.
 *
 * An entitlement is named `system::nativeId`, as the access request form's unusual-request check
 * names a catalog entry: the request's system and the entitlement's native id (its name when it
 * has none); for a policy grant, the catalog entry of its target on that system, found by native
 * id, else by the one entry with that name (catalogNames, through loadCatalogTargetLookup, as the
 * access graph keys it). A target the catalog does not know, or names more than once, keeps
 * `target::targetId`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { Identity, type IdentityDocument } from '../identity/schemas/identity.schema';
import { IdentityService } from '../identity/identity.service';
import {
  resolveStatus,
  type IdentityEntitlementStatus,
} from '../identity/identity-entitlements.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import {
  AccessRequest,
  type AccessRequestDocument,
} from '../access-requests/schemas/access-request.schema';
import {
  EntitlementCatalog,
  type EntitlementCatalogDocument,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { loadCatalogTargetLookup } from '../entitlement-catalog/catalog-target-lookup';

/** Operation types that grant access in a target system (as IdentityEntitlementsPolicyHandler). */
const GRANT_TYPES = new Set(['group', 'license', 'role']);

/** The request statuses the identity page lists (findActiveRequestsForIdentity). */
const LISTED_REQUEST_STATUSES = ['ACTIVE', 'PROVISIONING'];

export type GrantedBy = 'policy' | 'request';

export interface HeldGrant {
  /** `system::nativeId` (`system::id` when the catalog has no native id for it). */
  entitlementId: string;
  system: string;
  /** The catalog entry's name (the policy's target id when none matched), or the requested name. */
  name: string;
  grantedBy: GrantedBy;
  status: IdentityEntitlementStatus;
}

type RequestRow = Pick<AccessRequest, 'requesterId' | 'targetIdentityId' | 'status'> & {
  entitlements?: AccessRequest['entitlements'];
};

@Injectable()
export class HeldAccessService {
  private readonly logger = new Logger(HeldAccessService.name);

  constructor(
    @InjectModel(Identity.name) private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(AccessRequest.name) private readonly requestModel: Model<AccessRequestDocument>,
    @InjectModel(EntitlementCatalog.name)
    private readonly catalogModel: Model<EntitlementCatalogDocument>,
    private readonly identityService: IdentityService,
    private readonly policyEngine: PolicyEngineService,
  ) {}

  /**
   * Each identity's grants with their status. An identity that does not exist (or is deleted)
   * or whose policy evaluation fails is left out of the map; a failure is logged.
   */
  async grantsByIdentity(
    tenantId: string,
    identityIds: string[],
  ): Promise<Map<string, HeldGrant[]>> {
    const [identities, requests] = await Promise.all([
      this.identityModel
        .find({ tenantId, _id: { $in: identityIds }, deletedAt: null })
        .lean()
        .exec(),
      this.requestModel
        .find({
          tenantId,
          status: { $in: LISTED_REQUEST_STATUSES },
          $or: [
            { targetIdentityId: { $in: identityIds } },
            { targetIdentityId: null, requesterId: { $in: identityIds } },
          ],
        })
        .select('requesterId targetIdentityId status entitlements')
        .lean()
        .exec() as Promise<RequestRow[]>,
    ]);

    const policyByIdentity = new Map<string, HeldGrant[]>();
    for (const identity of identities) {
      const identityId = String(identity._id);
      try {
        const policy = await this.policyGrants(identity as unknown as IdentityDocument, tenantId);
        policyByIdentity.set(identityId, policy);
      } catch (err: unknown) {
        this.logger.warn(
          `Policy evaluation failed for identity ${identityId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const named = await this.catalogNames(tenantId, [...policyByIdentity.values()].flat());
    const result = new Map<string, HeldGrant[]>();
    for (const [identityId, policy] of policyByIdentity) {
      const requested = requests
        .filter((r) => (r.targetIdentityId || r.requesterId) === identityId)
        .flatMap(requestGrants);
      result.set(identityId, [...policy.map(named), ...requested]);
    }
    return result;
  }

  /**
   * Names each policy grant as the request form names the catalog entry of its target:
   * `system::nativeId` and the entry's name. The entry has the target id as its native id, or is
   * the only entry with a native id that has the target id as its name on the system. Any other
   * grant keeps its `target::targetId`.
   */
  private async catalogNames(
    tenantId: string,
    grants: HeldGrant[],
  ): Promise<(grant: HeldGrant) => HeldGrant> {
    // A policy grant's name is its target id until named here
    const target = (grant: HeldGrant) => ({ system: grant.system, targetId: grant.name });
    const entryOf = await loadCatalogTargetLookup(this.catalogModel, tenantId, grants.map(target));
    return (grant) => {
      const entry = entryOf(target(grant));
      return entry
        ? { ...grant, entitlementId: `${entry.system}::${entry.nativeId}`, name: entry.name }
        : grant;
    };
  }

  private async policyGrants(identity: IdentityDocument, tenantId: string): Promise<HeldGrant[]> {
    const profile = await this.identityService.buildProfileWithContractsForPolicy(identity);
    const operations = await this.policyEngine.evaluateOperationsWithoutSod(
      profile as unknown as StandardUserDto,
      tenantId,
    );
    const provisioning = identity.provisioning ?? [];
    return operations
      .filter((op) => op.action === 'add' && GRANT_TYPES.has(op.type))
      .map((op) => ({
        entitlementId: `${op.target}::${op.targetId}`,
        system: op.target,
        name: op.targetId,
        grantedBy: 'policy' as const,
        status: resolveStatus(
          {
            grantedBy: 'policy',
            entitlement: op.targetId,
            type: op.type,
            targetSystem: op.target,
            source: op.sourcePolicy,
          },
          provisioning,
        ),
      }));
  }
}

function requestGrants(request: RequestRow): HeldGrant[] {
  return (request.entitlements ?? []).map((e) => ({
    entitlementId: `${e.system}::${e.nativeId || e.entitlementName}`,
    system: e.system,
    name: e.entitlementName,
    grantedBy: 'request' as const,
    status: resolveStatus(
      {
        grantedBy: 'request',
        entitlement: e.entitlementName,
        type: (e.entitlementType ?? 'Group').toLowerCase(),
        targetSystem: e.system,
        source: 'Access request',
        requestStatus: request.status,
      },
      [],
    ),
  }));
}
