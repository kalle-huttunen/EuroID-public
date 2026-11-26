import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { IdentityDocument, ProvisioningState } from './schemas/identity.schema';
import { NOT_DELETED } from './identity.constants';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type {
  IdentityEntitlementGrant,
  IdentityEntitlementsQueryPayload,
  IdentityEntitlementsQueryResult,
} from '@infrastructure/events/event-payloads';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { normalizeSystemName, getSystemType } from '@shared/utils/normalize-system-name';

export type IdentityEntitlementStatus = 'Active' | 'Pending' | 'Revoked';

/** One row of GET /identity/:id/entitlements (shape read by the frontend AccessTab). */
export interface IdentityEntitlement {
  id: string;
  entitlement: string;
  type: string;
  source: string;
  targetSystem: string;
  grantedBy: IdentityEntitlementGrant['grantedBy'];
  status: IdentityEntitlementStatus;
  /** End of the access a time-bound request grants (request grants only). */
  expiresAt?: string;
}

export interface IdentityEntitlementsResponse {
  identityId: string;
  entitlements: IdentityEntitlement[];
}

function isEntitlementsQueryResult(value: unknown): value is IdentityEntitlementsQueryResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'identity-entitlements' &&
    Array.isArray((value as { grants?: unknown }).grants)
  );
}

function findProvisioningState(
  targetSystem: string,
  provisioning: ProvisioningState[],
): ProvisioningState | undefined {
  const normalized = normalizeSystemName(targetSystem);
  const systemType = getSystemType(targetSystem);
  return provisioning.find(
    (p) =>
      normalizeSystemName(p.targetSystem) === normalized ||
      (systemType !== 'unknown' && getSystemType(p.targetSystem) === systemType),
  );
}

/**
 * Policy grants follow the target system's provisioning state; request grants follow
 * the access request's lifecycle.
 */
export function resolveStatus(
  grant: IdentityEntitlementGrant,
  provisioning: ProvisioningState[],
): IdentityEntitlementStatus {
  if (grant.grantedBy === 'request') {
    if (grant.requestStatus === 'ACTIVE') return 'Active';
    if (grant.requestStatus === 'REVOKED' || grant.requestStatus === 'EXPIRED') return 'Revoked';
    return 'Pending';
  }
  const state = findProvisioningState(grant.targetSystem, provisioning)?.status;
  if (state === 'SYNCED') return 'Active';
  if (state === 'DEPROVISIONED') return 'Revoked';
  return 'Pending';
}

/**
 * Builds the per-identity entitlement view: what active policies grant the identity
 * (birthright access) plus what active access requests granted it, each with a status.
 * Policy and access-request data come from their modules via IDENTITY_ENTITLEMENTS_QUERY.
 */
@Injectable()
export class IdentityEntitlementsService {
  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** Returns null when the identity does not exist in the caller's tenant. */
  async getEntitlements(identityId: string): Promise<IdentityEntitlementsResponse | null> {
    const tenantId = getCurrentTenantId();
    const identity = await this.identityModel
      .findOne({ _id: identityId, tenantId, ...NOT_DELETED })
      .select('provisioning')
      .lean()
      .exec();
    if (!identity) return null;

    const results = await this.eventEmitter.emitAndWait<IdentityEntitlementsQueryPayload, unknown>(
      DomainEventType.IDENTITY_ENTITLEMENTS_QUERY,
      identityId,
      { identityId },
    );
    const grants = results.filter(isEntitlementsQueryResult).flatMap((r) => r.grants);
    const provisioning = identity.provisioning ?? [];

    return {
      identityId,
      entitlements: grants.map((grant) => ({
        id: [grant.grantedBy, grant.source, grant.targetSystem, grant.type, grant.entitlement].join(
          ':',
        ),
        entitlement: grant.entitlement,
        type: grant.type,
        source: grant.source,
        targetSystem: grant.targetSystem,
        grantedBy: grant.grantedBy,
        status: resolveStatus(grant, provisioning),
        ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
      })),
    };
  }
}
