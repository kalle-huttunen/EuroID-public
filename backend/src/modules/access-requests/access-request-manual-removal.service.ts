import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WorkflowNotFoundError } from '@temporalio/client';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { AccessRequestClosedPayload } from '@infrastructure/events/event-payloads';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { AccessRequest, type AccessRequestDocument } from './schemas/access-request.schema';

/** The request page's reason for a request an admin closed as removed by hand. */
export const removedManuallyReason = (note: string) =>
  `An admin removed the access by hand and closed the request: ${note}`;

/** 503 when the approval workflow could not be told: nothing is changed. */
export const REMOVAL_NOT_DELIVERED_MESSAGE =
  'The request was not closed: its approval workflow could not be reached. Try again in a moment.';

/**
 * Closes an ACTIVE request past its end date whose removal keeps failing (Entra ID refuses it,
 * so the approval workflow retries it every 6 hours) after an admin removed the access by hand
 * (POST /access-requests/:id/removed-manually, policy-admin, as closing a failed identity expiry:
 * it asserts a removal EuroID cannot verify). The request becomes EXPIRED with `removedManually`
 * (the admin, when, their note, and the failure it closes) and the note as its statusReason, and
 * then the run gets the REMOVED_MANUALLY signal, which stops its retries
 * (access-request-approval:revoke-closable-continue-as-new). Audited as access_request.closed
 * with the admin as actor and `removedManually: true`.
 *
 * Store first, then signal, as a decision does: a run that no longer exists (terminated) leaves
 * the request closed, which is the point; a signal that cannot be delivered (Temporal down)
 * puts the request back as it was and answers 503. 404: no such request in the tenant; 409: not
 * ACTIVE, its end date not passed, or it changed meanwhile.
 */
@Injectable()
export class AccessRequestManualRemovalService {
  private readonly logger = new Logger(AccessRequestManualRemovalService.name);

  constructor(
    @InjectModel(AccessRequest.name)
    private readonly accessRequestModel: Model<AccessRequestDocument>,
    private readonly temporalClient: TemporalClientProvider,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  async markRemovedManually(
    requestId: string,
    admin: string,
    note: string,
  ): Promise<AccessRequestDocument> {
    const tenantId = getCurrentTenantId();
    const doc = await this.accessRequestModel.findOne({ requestId, tenantId }).lean().exec();
    if (!doc) throw new NotFoundException('Access request not found');
    const endDate = doc.expiresAt ?? doc.timeConstraint?.expiresAt;
    if (doc.status !== 'ACTIVE' || !endDate || new Date(endDate).getTime() > Date.now()) {
      throw new ConflictException(
        'Only an ACTIVE request whose end date has passed (its access is due for removal) can ' +
          `be closed as removed by hand; this one is ${doc.status}` +
          (doc.status === 'ACTIVE' ? ' and its end date has not passed.' : '.'),
      );
    }

    const removedManually = {
      by: admin,
      at: new Date(),
      note,
      ...(doc.statusReason ? { failureReason: doc.statusReason } : {}),
    };
    const closed = await this.accessRequestModel
      .findOneAndUpdate(
        { requestId, tenantId, status: 'ACTIVE' },
        { $set: { status: 'EXPIRED', statusReason: removedManuallyReason(note), removedManually } },
        { new: true },
      )
      .exec();
    if (!closed) {
      throw new ConflictException(
        'The request changed meanwhile (its removal succeeded or someone closed it). Reload it.',
      );
    }

    if (doc.workflowId) await this.signalRun(doc, removedManually.at);

    this.eventEmitter.emit<AccessRequestClosedPayload>(
      DomainEventType.ACCESS_REQUEST_CLOSED,
      requestId,
      { requestId, status: 'EXPIRED', reason: note, removedManually: true },
      { actor: admin },
    );
    this.logger.log(`[AccessRequest] ${requestId} closed as removed by hand`);
    return closed;
  }

  /** Tells the run to stop retrying; undoes the closure (503) when it cannot be told. */
  private async signalRun(
    doc: Pick<AccessRequest, 'requestId' | 'workflowId' | 'statusReason'>,
    at: Date,
  ): Promise<void> {
    try {
      const handle = this.temporalClient.getClient().workflow.getHandle(doc.workflowId!);
      await handle.signal('REMOVED_MANUALLY');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof WorkflowNotFoundError) {
        // No run retries the removal any more: the closed request is all there is
        this.logger.warn(`[AccessRequest] ${doc.requestId}: approval workflow gone (${message})`);
        return;
      }
      this.logger.warn(`[AccessRequest] ${doc.requestId}: not closed, run not told (${message})`);
      // Back as it was: ACTIVE, with the failure's reason if it had one
      const restore = doc.statusReason
        ? {
            $set: { status: 'ACTIVE', statusReason: doc.statusReason },
            $unset: { removedManually: '' },
          }
        : { $set: { status: 'ACTIVE' }, $unset: { removedManually: '', statusReason: '' } };
      await this.accessRequestModel
        .updateOne(
          {
            requestId: doc.requestId,
            tenantId: getCurrentTenantId(),
            status: 'EXPIRED',
            'removedManually.at': at,
          },
          restore,
        )
        .exec();
      throw new ServiceUnavailableException(REMOVAL_NOT_DELIVERED_MESSAGE);
    }
  }
}
