import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import {
  IdentityMoveRequestedPayload,
  IdentityUpdatedPayload,
  MoverQueuedAnswer,
} from '../event-payloads';
import { IdentityService } from '../../../modules/identity/identity.service';
import { MoverService, type MoverStart } from '../../../modules/mover/mover.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';
import { CRITICAL_FIELDS } from '../../../modules/identity/identity.constants';
import { provisionedSystems } from '../../../modules/identity/identity-provisioning.service';
import { appliedAttributes } from '../../../shared/utils/access-baseline';

/**
 * The trigger attributes (CRITICAL_FIELDS) an edit moves: those it wrote whose value changed.
 * IdentityMutationService puts a before-value in previousAttributes only for a changed value, so
 * a trigger attribute the identity page sent unchanged moves nothing.
 */
export function movedTriggerFields(
  payload: Pick<IdentityUpdatedPayload, 'changedFields' | 'previousAttributes'>,
): string[] {
  const before = payload.previousAttributes ?? {};
  return (payload.changedFields ?? []).filter((f) => CRITICAL_FIELDS.includes(f) && f in before);
}

/**
 * The "before" of an edit's mover run, as for every mover run: the access baseline's values of
 * the moved trigger attributes (null where it has none), the profile access was last applied
 * with. A change not applied yet (a paused or rejected HR batch, a failed run) is then applied
 * too, and the completed run advances the baseline only for what it applied. An identity with
 * no baseline (provisioned before it existed) keeps the edit's values before the change, and
 * the completed run records its first baseline.
 */
export function moverPreviousAttributes(
  identity: { accessBaseline?: { attributes?: Record<string, unknown> } },
  movedFields: string[],
  beforeEdit: Record<string, unknown>,
): Record<string, unknown> {
  const baseline = identity.accessBaseline?.attributes;
  return baseline ? appliedAttributes(baseline, movedFields) : beforeEdit;
}

/**
 * The mover applies to an identity with an account in a target system: the rule the mover run
 * itself uses (provisionedSystems), so an identity whose only system is in ERROR after a failed
 * mover run is still the mover's, not onboarding's (which only adds access).
 */
export function isProvisionedForMover(
  identity: Parameters<typeof provisionedSystems>[0] | null | undefined,
): boolean {
  return !!identity && provisionedSystems(identity).length > 0;
}

/**
 * Mover Event Handler
 *
 * Starts the mover workflow when an edit (PATCH /identity/:id, identity.updated) changes a
 * trigger attribute of an identity that is provisioned to at least one target system. The
 * onboarding handler defers to it for exactly those edits (movedTriggerFields,
 * isProvisionedForMover); an identity with no account in a target system is left to onboarding.
 *
 * The run's "before" is the access baseline (moverPreviousAttributes), not the values the edit
 * replaced.
 *
 * PATCH /identity/:id starts its run itself and reports it: identity.updated then starts
 * nothing here (syncToEntra or moverRequested), and the controller asks through
 * identity.move_requested (emitAndWait), which answers the mover workflow id, a queued answer, or
 * undefined when the mover does not apply (onboarding then syncs, for ?syncToEntra=true). Two
 * runs must not change the same identity's access at once: while a run is open, the edit is
 * queued on it (MoverService.startOrQueueMover) and that run evaluates the identity once more
 * when it ends, so the edit is never lost. A run started with syncToEntra carries the sync: it
 * updates the Entra ID account also when it changes no access there.
 *
 * An HR sync does not emit IDENTITY_UPDATED: HR mover detection (modules/mover/
 * hr-mover-detection.service.ts) starts the mover for HR changes of the same CRITICAL_FIELDS,
 * comparing against the access baseline. A change outside CRITICAL_FIELDS starts no mover: the
 * identity's access preview shows it against the access baseline, and an operator applies it
 * with POST /identity/:id/access/re-evaluate (AccessReevaluationService).
 */
@Injectable()
export class MoverEventHandler {
  private readonly logger = new Logger(MoverEventHandler.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly moverService: MoverService,
  ) {}

  @OnEvent(DomainEventType.IDENTITY_UPDATED, { async: true })
  async handleIdentityUpdated(event: DomainEvent<IdentityUpdatedPayload>): Promise<void> {
    const depth = event.metadata?.depth ?? 0;
    if (depth > 0) return;
    // The PATCH starts this run itself (identity.move_requested), where it can report it
    if (event.payload.syncToEntra || event.payload.moverRequested) return;

    const triggerFields = movedTriggerFields(event.payload);
    if (triggerFields.length === 0) return;

    const identityId = event.payload.identityId;
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(`[Mover] IDENTITY_UPDATED for ${identityId} missing tenantId, skipping`);
      return;
    }

    try {
      await withTenantContext(tenantId, () =>
        this.startIfApplies(
          identityId,
          tenantId,
          triggerFields,
          event.payload.previousAttributes ?? {},
          event.metadata?.actor,
          false,
        ),
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Mover] Failed to trigger mover for ${identityId}: ${msg}`);
    }
  }

  // No `async: true`: called through emitAndWait, and EventEmitter2 would then return a
  // setImmediate handle instead of this result. suppressErrors: false lets a failed start reach
  // the controller, which reports a mover run already in progress as such.
  @OnEvent(DomainEventType.IDENTITY_MOVE_REQUESTED, { suppressErrors: false })
  async handleMoveRequested(
    event: DomainEvent<IdentityMoveRequestedPayload>,
  ): Promise<string | MoverQueuedAnswer | undefined> {
    const { identityId, previousAttributes } = event.payload;
    const tenantId = event.metadata?.tenantId;
    const triggerFields = movedTriggerFields(event.payload);
    if (!tenantId || triggerFields.length === 0) return undefined;

    const start = await withTenantContext(tenantId, () =>
      this.startIfApplies(
        identityId,
        tenantId,
        triggerFields,
        previousAttributes,
        event.metadata?.actor,
        event.payload.syncToEntra === true,
      ),
    );
    if (!start) return undefined;
    // A started run answers its id, as before; a queued edit says so (identity-sync-run.ts)
    return start.queued ? { moverQueued: true, workflowId: start.workflowId } : start.workflowId;
  }

  /**
   * The run started, or the open run the edit was queued on; undefined when the identity is not
   * provisioned (onboarding's).
   * @param beforeEdit the moved attributes' values before the edit
   * @param syncToEntra the edit asked for a sync to Entra ID, which the run then makes
   */
  private async startIfApplies(
    identityId: string,
    tenantId: string,
    changedFields: string[],
    beforeEdit: Record<string, unknown>,
    actor: string | undefined,
    syncToEntra: boolean,
  ): Promise<MoverStart | undefined> {
    const identity = await this.identityService.findIdentityById(identityId);
    if (!identity?.profile?.email) {
      this.logger.warn(`[Mover] Identity ${identityId} has no email, skipping`);
      return undefined;
    }
    if (!isProvisionedForMover(identity)) {
      this.logger.debug(
        `[Mover] Identity ${identityId} has no provisioned target, deferring to onboarding`,
      );
      return undefined;
    }

    this.logger.log(
      `[Mover] Identity ${identityId}: trigger attributes changed + provisioned targets exist, triggering mover`,
    );
    return this.moverService.startOrQueueMover(
      {
        identityId,
        tenantId,
        changedFields,
        previousAttributes: moverPreviousAttributes(identity, changedFields, beforeEdit),
        trigger: 'attribute-change',
        ...(syncToEntra ? { syncToEntra: true } : {}),
      },
      { requestedBy: actor },
    );
  }
}
