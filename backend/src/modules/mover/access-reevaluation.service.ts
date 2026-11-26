import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { IdentityService } from '../identity/identity.service';
import { provisionedSystems } from '../identity/identity-provisioning.service';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { AuditService } from '../audit/audit.service';
import { MoverService } from './mover.service';
import {
  POLICY_DECISION_PORT,
  type IPolicyDecisionPort,
} from '@shared/interfaces/policy-decision.port';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import {
  accessBaselineChanges,
  toAccessBaseline,
  type AccessBaseline,
} from '@shared/utils/access-baseline';
import {
  computeEntitlementDelta,
  isAppliedByMover,
  withoutRequestGrants,
  type EntitlementOperation,
} from '@shared/utils/entitlement-delta';
import {
  AccessRequest,
  type AccessRequestDocument,
} from '../access-requests/schemas/access-request.schema';
import { activeRequestGrants } from '../access-requests/active-request-grants';

/** One entitlement the re-evaluation would add or remove. */
export interface AccessPreviewEntitlement {
  type: string;
  target: string;
  targetId: string;
  sourcePolicy?: string;
  /**
   * False for a change the mover does not apply: a system other than Entra ID, AD, Okta and
   * SCIM, or a kind of entitlement its connector does not change (MOVER_OPERATION_TYPES).
   */
  appliedByMover: boolean;
}

/** GET /identity/:id/access/preview */
export interface AccessPreview {
  identityId: string;
  /** When the access baseline was last recorded; null when the identity has none. */
  baselineRecordedAt: string | null;
  /** Attributes whose value differs from the baseline: the baseline's value and the current one. */
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  toAdd: AccessPreviewEntitlement[];
  toRemove: AccessPreviewEntitlement[];
  /**
   * Target systems where the identity has an account (provisionedSystems, the mover's rule):
   * once provisioned, until a deprovision, also while a later run there is in ERROR.
   */
  provisionedTargets: string[];
  /** POST /identity/:id/access/re-evaluate would start a mover run. */
  canReevaluate: boolean;
  /** Why it would not, when canReevaluate is false. */
  blockedReason?: string;
}

const NO_BASELINE =
  'EuroID has no record of the attributes this identity’s access was last applied with ' +
  '(it was provisioned before that was recorded), so it cannot tell what to remove. ' +
  'The record starts at the next provisioning.';
const NO_TARGET =
  'The identity is not provisioned to any target system yet: onboarding gives it access, ' +
  'not a re-evaluation.';

/**
 * Access preview and re-evaluation for one identity (2.2). Both compare the identity's current
 * policy profile with its access baseline (the profile its access was last applied with,
 * shared/utils/access-baseline.ts), evaluating the active policies against each:
 * - preview: read-only, the entitlements a re-evaluation would add and remove (not a removal of
 *   what an active access request also grants, as the run). No writes, no
 *   workflow, no events (the SoD-free evaluation emits none). SoD blockers are not checked here;
 *   the mover run refuses then and its timeline entry says why. Evaluated also when no attribute
 *   changed: an access review exclusion lifted since the baseline gives its access back (the
 *   baseline side still leaves it out, as the mover run's does).
 * - reevaluate: starts the mover workflow with the baseline values of the changed attributes as
 *   previousAttributes, the same run an attribute change starts, so the delta it applies is the
 *   preview's (given no change in between).
 * The tenant is the request's; another tenant's identity is not found.
 */
@Injectable()
export class AccessReevaluationService {
  constructor(
    private readonly identityService: IdentityService,
    private readonly moverService: MoverService,
    private readonly auditService: AuditService,
    @Inject(POLICY_DECISION_PORT) private readonly policy: IPolicyDecisionPort,
    // Read only: the preview, as the mover run, keeps what an active access request grants
    @InjectModel(AccessRequest.name)
    private readonly accessRequestModel: Model<AccessRequestDocument>,
  ) {}

  async preview(identityId: string): Promise<AccessPreview> {
    const identity = await this.findIdentity(identityId);
    const tenantId = getCurrentTenantId();
    const profile = await this.identityService.buildProfileWithContractsForPolicy(identity);
    const baseline = this.baselineOf(identity);
    const provisionedTargets = provisionedSystems(identity);
    const blockedReason = !baseline
      ? NO_BASELINE
      : provisionedTargets.length
        ? undefined
        : NO_TARGET;
    const result: AccessPreview = {
      identityId,
      baselineRecordedAt: baseline ? new Date(baseline.recordedAt).toISOString() : null,
      changes: [],
      toAdd: [],
      toRemove: [],
      provisionedTargets,
      canReevaluate: blockedReason === undefined,
      ...(blockedReason ? { blockedReason } : {}),
    };
    if (!baseline) return result;

    const current = toAccessBaseline(profile);
    const previous = accessBaselineChanges(baseline.attributes, current);
    result.changes = Object.entries(previous).map(([field, before]) => ({
      field,
      before,
      after: current[field] ?? null,
    }));

    const [newOps, oldOps] = await Promise.all([
      this.policy.evaluateOperationsWithoutSod(profile as unknown as StandardUserDto, tenantId),
      this.policy.evaluateOperationsWithoutSod(
        { ...profile, ...previous } as unknown as StandardUserDto,
        tenantId,
        { reviewExclusionsLiftedSince: new Date(baseline.recordedAt) },
      ),
    ]);
    const delta = computeEntitlementDelta(oldOps, newOps);
    const grants = await activeRequestGrants(this.accessRequestModel, tenantId, identityId);
    result.toAdd = delta.toAdd.map(toPreviewEntitlement);
    result.toRemove = withoutRequestGrants(delta.toRemove, grants).map(toPreviewEntitlement);
    return result;
  }

  /**
   * Start a mover run that applies what the preview shows. 404 for an unknown identity (or one of
   * another tenant), 409 without a baseline, without a provisioned target, or while a mover run
   * for the identity is in progress. Audited with the operator as actor.
   */
  async reevaluate(
    identityId: string,
    actor: string,
  ): Promise<{ workflowId: string; changedFields: string[] }> {
    const identity = await this.findIdentity(identityId);
    const tenantId = getCurrentTenantId();
    const baseline = this.baselineOf(identity);
    if (!baseline) throw new ConflictException(NO_BASELINE);
    if (provisionedSystems(identity).length === 0) throw new ConflictException(NO_TARGET);

    const profile = await this.identityService.buildProfileWithContractsForPolicy(identity);
    const previousAttributes = accessBaselineChanges(
      baseline.attributes,
      toAccessBaseline(profile),
    );
    const changedFields = Object.keys(previousAttributes);

    let workflowId: string;
    try {
      workflowId = await this.moverService.triggerMover(
        { identityId, tenantId, changedFields, previousAttributes, trigger: 're-evaluate' },
        { requestedBy: actor },
      );
    } catch (error: unknown) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        throw new ConflictException('A mover run for this identity is already in progress.');
      }
      throw error;
    }

    await this.auditService.log({
      action: 'ACCESS_REEVALUATION_REQUESTED',
      severity: 'info',
      actor,
      resourceType: 'identity',
      resourceId: identityId,
      resourceName: `Identity ${identityId}`,
      description:
        `Access re-evaluation started (mover ${workflowId}): ` +
        (changedFields.join(', ') || 'no attribute changed since access was last applied'),
      payload: { metadata: { workflowId, changedFields } },
      tenantId,
    });
    return { workflowId, changedFields };
  }

  private async findIdentity(identityId: string): Promise<IdentityDocument> {
    const identity = await this.identityService.findIdentityById(identityId);
    if (!identity) throw new NotFoundException('Identity not found');
    return identity;
  }

  private baselineOf(identity: IdentityDocument): AccessBaseline | undefined {
    const baseline = identity.accessBaseline;
    return baseline?.attributes ? baseline : undefined;
  }
}

function toPreviewEntitlement(op: EntitlementOperation): AccessPreviewEntitlement {
  return {
    type: op.type,
    target: op.target,
    targetId: op.targetId,
    ...(op.sourcePolicy ? { sourcePolicy: op.sourcePolicy } : {}),
    appliedByMover: isAppliedByMover(op),
  };
}
