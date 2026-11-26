import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WorkflowNotFoundError } from '@temporalio/client';
import type { AccessRequestDocument, AccessRequestStatus } from './schemas/access-request.schema';
import { AccessRequest, stepRole } from './schemas/access-request.schema';
import { releaseDecision, releaseDelegation, type ClaimRelease } from './decision-claims';
import { IDENTITY_QUERY_PORT, IIdentityQueryPort } from '@shared/interfaces/identity-query.port';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { ApprovalDecision } from '../../workflows/access-request-approval.workflow';
import { AccessRequestQueryService } from './access-request-query.service';
import { AccessRequestClosureService, CLOSE_REASONS } from './access-request-closure.service';
import { maskEmail } from '../identity/identity-pii';

/** 409 for a decision on a request whose approval workflow had ended (the request is closed). */
export const WORKFLOW_GONE_MESSAGE = `${CLOSE_REASONS.workflowGone} The request was closed.`;

/** 503 for a decision the approval workflow could not be told about (Temporal unreachable). */
export const DECISION_NOT_DELIVERED_MESSAGE =
  'Your decision was not recorded: the approval workflow could not be reached. ' +
  'Try again in a moment.';

@Injectable()
export class AccessRequestDecisionService {
  private readonly logger = new Logger(AccessRequestDecisionService.name);

  constructor(
    @InjectModel(AccessRequest.name)
    private readonly accessRequestModel: Model<AccessRequestDocument>,
    @Inject(IDENTITY_QUERY_PORT) private readonly identityQuery: IIdentityQueryPort,
    private readonly temporalClient: TemporalClientProvider,
    private readonly query: AccessRequestQueryService,
    private readonly closure: AccessRequestClosureService,
  ) {}

  /**
   * Records the decision on a step that is still pending, with who decided. A step another
   * approver decided meanwhile (several holders of a ROLE step) is not decided again.
   */
  private async recordDecision(
    requestId: string,
    stepIndex: number,
    set: Record<string, unknown>,
  ): Promise<void> {
    const tenantId = getCurrentTenantId();
    const result = await this.accessRequestModel
      .updateOne(
        {
          requestId,
          tenantId,
          status: 'PENDING_APPROVAL',
          [`approvalSteps.${stepIndex}.status`]: 'PENDING',
        },
        { $set: set },
      )
      .exec();
    if (result.modifiedCount === 0) {
      throw new BadRequestException('This approval step has already been decided');
    }
  }

  /**
   * Tells the approval workflow about a decision already claimed in the request (claim, then
   * signal: the claim keeps two approvers from deciding one step). When the workflow no longer
   * exists the request can never move on: it is closed CANCELLED with the reason (audited, actor
   * `system`; the claimed decision stays on the step) and the approver gets 409. When the signal
   * fails otherwise (Temporal unreachable), `release` undoes the claim and the approver gets 503
   * to try again. `claimedStatus`: the request's status the claim left.
   */
  private async signalDecision(
    doc: AccessRequestDocument,
    decision: ApprovalDecision,
    claimedStatus: AccessRequestStatus,
    release: () => Promise<unknown>,
  ): Promise<void> {
    const { requestId } = doc;
    try {
      const handle = this.temporalClient.getClient().workflow.getHandle(doc.workflowId!);
      await handle.signal('APPROVAL_DECISION', decision);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof WorkflowNotFoundError) {
        this.logger.warn(`[AccessRequest] ${requestId}: approval workflow gone (${message})`);
        await this.closure.close(requestId, 'CANCELLED', CLOSE_REASONS.workflowGone, claimedStatus);
        throw new ConflictException(WORKFLOW_GONE_MESSAGE);
      }
      this.logger.warn(
        `[AccessRequest] ${requestId} step ${decision.stepIndex}: ${decision.decision} not ` +
          `delivered, claim released (${message})`,
      );
      await release();
      throw new ServiceUnavailableException(DECISION_NOT_DELIVERED_MESSAGE);
    }
  }

  /** Runs `undo` (a claim release from decision-claims.ts) on the request in this tenant. */
  private releaseClaim(requestId: string, undo: ClaimRelease): Promise<unknown> {
    return this.accessRequestModel
      .updateOne({ requestId, tenantId: getCurrentTenantId(), ...undo.filter }, undo.update)
      .exec();
  }

  async approve(
    requestId: string,
    stepIndex: number,
    approverId: string,
    approverEmail: string,
    justification?: string,
  ): Promise<void> {
    const doc = await this.getAndValidateForDecision(
      requestId,
      stepIndex,
      approverId,
      approverEmail,
    );
    const step = doc.approvalSteps[stepIndex];
    if (step.status !== 'PENDING') {
      throw new BadRequestException('This approval step has already been decided');
    }

    const decidedAt = new Date();
    await this.recordDecision(requestId, stepIndex, {
      [`approvalSteps.${stepIndex}.status`]: 'APPROVED',
      [`approvalSteps.${stepIndex}.decidedAt`]: decidedAt,
      [`approvalSteps.${stepIndex}.decidedBy`]: approverEmail,
      [`approvalSteps.${stepIndex}.justification`]: justification,
    });

    await this.signalDecision(
      doc,
      { stepIndex, decision: 'approve', justification },
      'PENDING_APPROVAL',
      () => this.releaseClaim(requestId, releaseDecision(stepIndex, decidedAt, false)),
    );
    this.logger.log(
      `[AccessRequest] ${requestId} step ${stepIndex} approved by ${maskEmail(approverEmail)}`,
    );
  }

  async reject(
    requestId: string,
    stepIndex: number,
    approverId: string,
    approverEmail: string,
    justification?: string,
  ): Promise<void> {
    const doc = await this.getAndValidateForDecision(
      requestId,
      stepIndex,
      approverId,
      approverEmail,
    );
    const decidedAt = new Date();
    await this.recordDecision(requestId, stepIndex, {
      status: 'REJECTED',
      [`approvalSteps.${stepIndex}.status`]: 'REJECTED',
      [`approvalSteps.${stepIndex}.decidedAt`]: decidedAt,
      [`approvalSteps.${stepIndex}.decidedBy`]: approverEmail,
      [`approvalSteps.${stepIndex}.justification`]: justification,
    });

    await this.signalDecision(
      doc,
      { stepIndex, decision: 'reject', justification },
      'REJECTED',
      () => this.releaseClaim(requestId, releaseDecision(stepIndex, decidedAt, true)),
    );
    this.logger.log(`[AccessRequest] ${requestId} rejected by ${maskEmail(approverEmail)}`);
  }

  async cancel(requestId: string, requesterId: string): Promise<void> {
    const tenantId = getCurrentTenantId();
    const doc = await this.accessRequestModel.findOne({ requestId, tenantId }).exec();
    if (!doc) throw new NotFoundException('Access request not found');
    if (doc.requesterId !== requesterId) {
      throw new ForbiddenException('Only the requester can cancel this request');
    }
    if (doc.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException('Only pending requests can be cancelled');
    }

    // The claim: a request claimed for fulfilment since it was read stays as it is
    const claimed = await this.accessRequestModel
      .updateOne(
        { requestId, tenantId, status: 'PENDING_APPROVAL' },
        { $set: { status: 'CANCELLED' } },
      )
      .exec();
    if (claimed.modifiedCount === 0) {
      throw new BadRequestException('Only pending requests can be cancelled');
    }
    if (doc.workflowId) {
      try {
        const handle = this.temporalClient.getClient().workflow.getHandle(doc.workflowId);
        await handle.signal('CANCEL_REQUEST');
      } catch {
        // Workflow may already be done
      }
    }
    this.logger.log(`[AccessRequest] ${requestId} cancelled by requester`);
  }

  async delegate(
    requestId: string,
    stepIndex: number,
    fromApproverId: string,
    fromApproverEmail: string,
    delegateTo: string,
  ): Promise<void> {
    const doc = await this.getAndValidateForDecision(
      requestId,
      stepIndex,
      fromApproverId,
      fromApproverEmail,
    );
    const tenantId = getCurrentTenantId();

    const newApprover =
      (await this.identityQuery.findByEmail(delegateTo)) ??
      (await this.identityQuery.findById(delegateTo));
    if (!newApprover) {
      throw new BadRequestException(
        `Delegate target ${delegateTo} not found. User must exist in the identity directory.`,
      );
    }
    const newApproverId = newApprover._id ? String(newApprover._id) : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- identity is a dynamic lean document from identity service
    const typedApprover = newApprover as any;
    const newApproverEmail: string =
      typedApprover.profile?.email ?? typedApprover.email ?? delegateTo;
    // Segregation of duties: never to the requester or the person the access is for
    if (
      newApproverId === doc.requesterId ||
      newApproverEmail.toLowerCase() === doc.requesterEmail?.toLowerCase() ||
      (!!doc.targetIdentityId && newApproverId === doc.targetIdentityId)
    ) {
      throw new BadRequestException(
        'An approval step cannot be delegated to the requester or to the person the access is for',
      );
    }

    // The claim: only a step still waiting for a decision is handed over
    const previous = doc.approvalSteps[stepIndex];
    const delegated = {
      approverId: newApproverId ?? delegateTo,
      approverEmail: newApproverEmail,
      delegatedFrom: fromApproverEmail,
    };
    const claimed = await this.accessRequestModel
      .updateOne(
        {
          requestId,
          tenantId,
          status: 'PENDING_APPROVAL',
          [`approvalSteps.${stepIndex}.status`]: 'PENDING',
        },
        {
          $set: {
            [`approvalSteps.${stepIndex}.approverId`]: delegated.approverId,
            [`approvalSteps.${stepIndex}.approverEmail`]: delegated.approverEmail,
            [`approvalSteps.${stepIndex}.delegatedFrom`]: delegated.delegatedFrom,
          },
        },
      )
      .exec();
    if (claimed.modifiedCount === 0) {
      throw new BadRequestException('This approval step has already been decided');
    }

    await this.signalDecision(
      doc,
      { stepIndex, decision: 'delegate', delegateTo },
      'PENDING_APPROVAL',
      () => this.releaseClaim(requestId, releaseDelegation(stepIndex, previous, delegated)),
    );
    this.logger.log(
      `[AccessRequest] ${requestId} step ${stepIndex} delegated by ${maskEmail(fromApproverEmail)} ` +
        `to ${maskEmail(newApproverEmail)}`,
    );
  }

  private async getAndValidateForDecision(
    requestId: string,
    stepIndex: number,
    approverId: string,
    approverEmail: string,
  ): Promise<AccessRequestDocument> {
    const tenantId = getCurrentTenantId();
    const doc = await this.accessRequestModel.findOne({ requestId, tenantId }).exec();
    if (!doc) throw new NotFoundException('Access request not found');
    if (doc.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException('Request is not pending approval');
    }

    // Segregation of Duties: prevent self-approval
    if (
      doc.requesterId === approverId ||
      doc.requesterEmail?.toLowerCase() === approverEmail?.toLowerCase()
    ) {
      throw new ForbiddenException(
        'Segregation of Duties: You cannot approve your own access request',
      );
    }

    // ... and the person the access is for never approves their own access
    if (doc.targetIdentityId && approverId === doc.targetIdentityId) {
      throw new ForbiddenException(
        'Segregation of Duties: You cannot approve access requested for you',
      );
    }

    const step = doc.approvalSteps[stepIndex];
    if (!step) throw new BadRequestException('Invalid approval step');
    const role = stepRole(step) ? await this.query.approverRoleOf(approverEmail) : null;
    if (!this.query.isStepApprover(step, approverId, approverEmail, role)) {
      throw new ForbiddenException('You are not the designated approver for this step');
    }
    return doc;
  }
}
