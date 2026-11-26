import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { hrStartTimeoutMs } from '@infrastructure/config/defaults';
import { withTimeout } from '@shared/utils/with-timeout';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { LeaverEvent, LeaverEventDocument } from '../leavers/schemas/leaver-event.schema';
import { MoverService } from './mover.service';
import {
  HR_MOVER_PROJECTION,
  hrMoverCandidate,
  moverInputOf,
  type HrMoverCandidate,
  type IdentityForHrMover,
} from './hr-mover-changes';

/** Who starts HR-driven mover runs when no person does (a sync under the mass-mover limit). */
export const HR_MOVER_SYSTEM_ACTOR = 'system:hr-sync';

/** Longest start error kept on a batch item. */
const MAX_ERROR_LENGTH = 300;

export type HrMoverStartResult =
  | { outcome: 'started'; workflowId: string }
  | { outcome: 'already-running' }
  | { outcome: 'failed'; error: string };

/**
 * Starts HR-driven mover runs through the existing mover path (MoverService.triggerMover, trigger
 * `hr-sync`), and knows which identities an HR leaver is offboarding: those never get one.
 *
 * Leaver state is read from `leaver_events` (modules/leavers, read only): HR ingestion asks for
 * mover detection only after leaver detection answered (HR_SYNC_MOVERS_REQUESTED), so this
 * run's leavers are already there.
 */
@Injectable()
export class HrMoverExecutionService {
  private readonly logger = new Logger(HrMoverExecutionService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(LeaverEvent.name) private readonly leaverEventModel: Model<LeaverEventDocument>,
    private readonly moverService: MoverService,
  ) {}

  /**
   * The identities among `identityIds` that an HR leaver is offboarding: an open leaver event
   * (waiting for approval or queued), or a started offboarding that has not reported its result.
   */
  async inOffboarding(tenantId: string, identityIds: string[]): Promise<Set<string>> {
    if (identityIds.length === 0) return new Set();
    const ids = await this.leaverEventModel
      .distinct('identityId', {
        tenantId,
        identityId: { $in: identityIds },
        $or: [{ open: true }, { status: 'started', offboardingFinishedAt: { $exists: false } }],
      })
      .exec();
    return new Set(ids.map(String));
  }

  /**
   * What an HR mover run for the identity would apply now (an approval re-reads the identity), or
   * why there is none.
   */
  async currentCandidate(
    tenantId: string,
    identityId: string,
  ): Promise<{ candidate: HrMoverCandidate } | { reason: string }> {
    if (!isValidObjectId(identityId)) return { reason: 'Identity not found.' };
    const identity = (await this.identityModel
      .findOne({ _id: identityId, tenantId, deletedAt: null })
      .select(HR_MOVER_PROJECTION)
      .lean()
      .exec()) as unknown as IdentityForHrMover | null;
    if (!identity) return { reason: 'The identity was deleted.' };
    if ((await this.inOffboarding(tenantId, [identityId])).size > 0) {
      return { reason: 'An HR leaver offboarding is in progress for the identity.' };
    }
    const result = hrMoverCandidate(identity);
    return 'candidate' in result ? result : { reason: result.reason };
  }

  /**
   * Start the mover run for one candidate: before = its access baseline's values of the changed
   * trigger attributes, as POST /identity/:id/access/re-evaluate does. One run per identity at a
   * time: a running one is reported, not replaced. A start that does not answer within
   * HR_START_TIMEOUT_MS counts as failed.
   */
  async start(
    tenantId: string,
    candidate: HrMoverCandidate,
    actor: string,
  ): Promise<HrMoverStartResult> {
    try {
      const ms = hrStartTimeoutMs();
      const workflowId = await withTimeout(
        this.moverService.triggerMover(
          {
            identityId: candidate.identityId,
            tenantId,
            ...moverInputOf(candidate.changes),
            trigger: 'hr-sync',
          },
          { requestedBy: actor },
        ),
        ms,
        `The mover start did not answer within ${ms} ms`,
      );
      return { outcome: 'started', workflowId };
    } catch (err: unknown) {
      if (err instanceof WorkflowExecutionAlreadyStartedError)
        return { outcome: 'already-running' };
      const error = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
      this.logger.warn(
        `[HrMover] Mover start failed for identity ${candidate.identityId}: ${error}`,
      );
      return { outcome: 'failed', error };
    }
  }
}
