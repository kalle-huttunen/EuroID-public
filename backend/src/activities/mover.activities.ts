import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { MoverCompletedPayload } from '@infrastructure/events/event-payloads';
import {
  computeEntitlementDelta,
  withoutRequestGrants,
  type EntitlementDelta as Delta,
} from '@shared/utils/entitlement-delta';
import {
  accessBaselineChanges,
  appliedAttributes,
  type AccessBaselineAttributes,
} from '@shared/utils/access-baseline';
import type { MoverEvaluation, MoverOutcome, MoverPolicyOperation } from '@shared/types/mover';
import { SOD_VIOLATION_FAILURE } from '@shared/types/sod-violation';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { IdentityService } from '../modules/identity/identity.service';
import { provisionedSystems } from '../modules/identity/identity-provisioning.service';
import { PolicyActivities } from './policy.activities';
import { maskEmails } from './deprovision-failure';
import { PII_MASK_CHAR } from '../modules/identity/identity-pii';
import {
  AccessRequest,
  type AccessRequestDocument,
} from '../modules/access-requests/schemas/access-request.schema';
import { activeRequestGrants } from '../modules/access-requests/active-request-grants';

/**
 * [ACTIVITIES] Mover Activities
 * --------------------------------
 * Temporal-compatible activities for the Mover workflow (role/department change, re-evaluation).
 *
 * - evaluateMoverChange (patch mover:identity-by-id): reads the identity by id, evaluates the
 *   policies with its previous and its current attribute values and returns the delta, so the
 *   profile never enters workflow history
 * - computeEntitlementDelta: set difference of two policy evaluations (shared/utils/entitlement-delta);
 *   runs from before that patch
 * - recordMoverOutcome: advances the identity's access baseline after a completed run and
 *   publishes the run's result (mover.completed / mover.failed) for the identity timeline
 * The connector side (applyMoverAccess) is in mover-access.activities.ts.
 */

/** A single provisioning operation from the policy engine */
interface PolicyOperation {
  type: string;
  action: string;
  target: string;
  targetId: string;
  sourcePolicy?: string;
  params?: Record<string, string | number | boolean>;
}

/** The delta between old and new policy evaluations */
export type EntitlementDelta = Delta<PolicyOperation>;

/** Failure type of a mover run the policies refuse (a BLOCK SoD policy): evaluateUser's. */
export const MOVER_SOD_VIOLATION = SOD_VIOLATION_FAILURE;

/** Longest failure reason kept on the timeline. */
const MAX_REASON_LENGTH = 500;

const shortReason = (reason: string | undefined) =>
  reason === undefined ? undefined : maskEmails(reason).slice(0, MAX_REASON_LENGTH);

/** What history keeps of a policy operation: no params (they are the policy's configuration). */
const entitlementOf = (op: PolicyOperation): MoverPolicyOperation => ({
  type: op.type,
  action: op.action,
  target: op.target,
  targetId: op.targetId,
  ...(op.sourcePolicy ? { sourcePolicy: op.sourcePolicy } : {}),
});

/**
 * The attributes the "before" side of a move adds to the current policy profile. The policies
 * also evaluate the identity's HR contracts (one per HR source, with its title and department;
 * IdentityOnionService.buildProfileWithContractsForPolicy), read from the HR data as it is now. An
 * HR move changes them along with the profile, so a "before" side with only the previous profile
 * values still matched the new department's policies through the contract, and the move added
 * nothing. Unless the run names their previous value (a re-evaluation does), the contracts access
 * was last applied with (the access baseline's) go to the "before" side, and the run applies the
 * current ones (returned in `contracts`, for the baseline).
 */
function previousSide(
  profile: Record<string, unknown>,
  edited: Record<string, unknown>,
  baseline: AccessBaselineAttributes | undefined,
): { previous: Record<string, unknown>; contracts?: unknown } {
  const previousAttributes = unmaskFromBaseline(edited, baseline);
  if (!baseline || 'contracts' in previousAttributes) return { previous: previousAttributes };
  const moved = accessBaselineChanges(
    { contracts: baseline.contracts },
    { contracts: profile.contracts },
  );
  if (!('contracts' in moved)) return { previous: previousAttributes };
  return {
    previous: { ...previousAttributes, contracts: baseline.contracts },
    contracts: profile.contracts ?? null,
  };
}

/**
 * An edit's identity.updated carries an email-valued before-value masked (managerEmail; the event
 * reaches the audit log, the analytics index and the websocket). The policies are evaluated with
 * the access baseline's value instead, the one access was last applied with (null when it had
 * none). Without a baseline the masked value stays: no rule on the old value matches.
 */
function unmaskFromBaseline(
  previousAttributes: Record<string, unknown>,
  baseline: AccessBaselineAttributes | undefined,
): Record<string, unknown> {
  if (!baseline) return previousAttributes;
  const out = { ...previousAttributes };
  for (const [key, value] of Object.entries(previousAttributes)) {
    if (typeof value === 'string' && value.includes(PII_MASK_CHAR))
      out[key] = baseline[key] ?? null;
  }
  return out;
}

@Injectable()
export class MoverActivities {
  private readonly logger = new Logger(MoverActivities.name);

  constructor(
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly identityService: IdentityService,
    private readonly policyActivities: PolicyActivities,
    // Read only: access an active request grants is not removed by a move (activeRequestGrants)
    @InjectModel(AccessRequest.name)
    private readonly accessRequestModel: Model<AccessRequestDocument>,
  ) {}

  /**
   * The entitlement change of a move, for the identity with this id in the tenant: the policies
   * evaluated with the identity's policy profile (as onboarding evaluates it) and with that
   * profile plus `previousAttributes`, and the difference (computeEntitlementDelta). Returns
   * entitlement ids, the changed attributes' current values and the names of the target systems
   * the identity is provisioned to (provisionedSystems) only; null when the identity does not
   * exist (or is deleted). A BLOCK SoD conflict fails at once (MOVER_SOD_VIOLATION, naming
   * the SoD policies); other failures are retried. Both sides leave out what an active access
   * review exclusion revoked; the "before" side also what one lifted since the access baseline
   * was recorded took away, so a lift's access comes back as an add. A removal of what one of the
   * identity's active access requests also grants is left out (withoutRequestGrants).
   */
  async evaluateMoverChange(
    identityId: string,
    changedFields: string[],
    previousAttributes: Record<string, unknown>,
    tenantId: string,
    correlationId?: string,
  ): Promise<MoverEvaluation | null> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        const identity = await this.identityService.findIdentityById(identityId);
        if (!identity?.profile) return null;
        const profile = await this.identityService.buildProfileWithContractsForPolicy(identity);
        const side = previousSide(profile, previousAttributes, identity.accessBaseline?.attributes);
        const now = profile as unknown as StandardUserDto;
        const before = { ...profile, ...side.previous } as unknown as StandardUserDto;
        const current = await this.evaluate(now, tenantId, correlationId);
        const baselineAt = identity.accessBaseline?.recordedAt;
        const previous = await this.evaluate(
          before,
          tenantId,
          correlationId,
          baselineAt ? new Date(baselineAt) : undefined,
        );
        const delta = computeEntitlementDelta(previous, current);
        // What an active access request also grants stays (the request's own end removes it)
        const grants = await activeRequestGrants(this.accessRequestModel, tenantId, identityId);
        const toRemove = withoutRequestGrants(delta.toRemove, grants);
        this.logger.log(
          `Mover evaluation for identity ${identityId}: +${delta.toAdd.length} add, ` +
            `-${toRemove.length} remove` +
            (toRemove.length < delta.toRemove.length
              ? ` (${delta.toRemove.length - toRemove.length} kept: an access request grants them)`
              : ''),
        );
        return {
          applied: {
            ...appliedAttributes(profile, changedFields),
            ...('contracts' in side ? { contracts: side.contracts } : {}),
          },
          toAdd: delta.toAdd.map(entitlementOf),
          toRemove: toRemove.map(entitlementOf),
          operationCounts: { before: previous.length, after: current.length },
          provisionedSystems: provisionedSystems(identity),
        };
      },
      { correlationId },
    );
  }

  /**
   * evaluateUser fails a BLOCK SoD conflict without retry (MOVER_SOD_VIOLATION).
   * `exclusionsLiftedSince`: the "before" side, the access baseline's time.
   */
  private async evaluate(
    profile: StandardUserDto,
    tenantId: string,
    correlationId?: string,
    exclusionsLiftedSince?: Date,
  ): Promise<PolicyOperation[]> {
    const intent = exclusionsLiftedSince
      ? await this.policyActivities.evaluateUser(profile, tenantId, correlationId, {
          reviewExclusionsLiftedSince: exclusionsLiftedSince,
        })
      : await this.policyActivities.evaluateUser(profile, tenantId, correlationId);
    return intent.operations as PolicyOperation[];
  }

  /**
   * Compute the entitlement delta between old and new policy evaluations:
   * toAdd = 'add' operations only the new evaluation has; toRemove = 'add' operations only the
   * old one has, as 'remove'.
   */
  async computeEntitlementDelta(
    oldOps: PolicyOperation[],
    newOps: PolicyOperation[],
    tenantId?: string,
    correlationId?: string,
  ): Promise<EntitlementDelta> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const delta = computeEntitlementDelta(oldOps, newOps);
        this.logger.log(
          `Entitlement delta: +${delta.toAdd.length} add, -${delta.toRemove.length} remove`,
        );
        return delta;
      },
      { correlationId },
    );
  }

  /**
   * Record a mover run's result. When the run completed (or found nothing to change), `applied`
   * (the attribute values it evaluated) becomes the identity's access baseline for those
   * attributes first, so the access preview no longer shows them as pending. Then the result is
   * published: mover.completed, or mover.failed for a failed run. Reasons are shortened and
   * emails in them masked. Idempotent on retry apart from a repeated event.
   */
  async recordMoverOutcome(
    outcome: MoverOutcome,
    applied?: AccessBaselineAttributes,
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    await withTenantContext(
      tenantId ?? '',
      async () => {
        if (applied && (outcome.status === 'completed' || outcome.status === 'no-change')) {
          await this.identityService.advanceAccessBaseline(outcome.identityId, applied);
        }
        const payload: MoverCompletedPayload = {
          ...outcome,
          ...(outcome.reason !== undefined ? { reason: shortReason(outcome.reason) } : {}),
          systems: outcome.systems.map((s) =>
            s.reason !== undefined ? { ...s, reason: shortReason(s.reason) } : s,
          ),
        };
        this.eventEmitter.emit<MoverCompletedPayload>(
          outcome.status === 'failed'
            ? DomainEventType.MOVER_FAILED
            : DomainEventType.MOVER_COMPLETED,
          outcome.identityId,
          payload,
          { tenantId, actor: 'mover-workflow' },
        );
        this.logger.log(`Mover ${outcome.workflowId}: ${outcome.status}`);
      },
      { correlationId },
    );
  }
}
