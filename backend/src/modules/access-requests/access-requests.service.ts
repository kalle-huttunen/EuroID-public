import { Injectable } from '@nestjs/common';
import type { AccessRequestDocument } from './schemas/access-request.schema';
import { type CreateAccessRequestDto } from './dtos/create-access-request.dto';
import { type PreCheckSodDto } from './dtos/pre-check-sod.dto';
import { AccessRequestCreationService } from './access-request-creation.service';
import { AccessRequestDecisionService } from './access-request-decision.service';
import { AccessRequestQueryService } from './access-request-query.service';

/**
 * Facade over the three focused access-request sub-services.
 * Preserves the controller/handler/test contract while keeping each concern in its own file.
 */
@Injectable()
export class AccessRequestsService {
  constructor(
    private readonly creation: AccessRequestCreationService,
    private readonly decision: AccessRequestDecisionService,
    private readonly query: AccessRequestQueryService,
  ) {}

  createRequest(
    dto: CreateAccessRequestDto,
    requesterId: string,
    requesterEmail: string,
  ): Promise<AccessRequestDocument> {
    return this.creation.createRequest(dto, requesterId, requesterEmail);
  }

  preCheckSod(
    dto: PreCheckSodDto,
    requesterId: string,
    requesterEmail: string,
  ): ReturnType<AccessRequestCreationService['preCheckSod']> {
    return this.creation.preCheckSod(dto, requesterId, requesterEmail);
  }

  approve(
    requestId: string,
    stepIndex: number,
    approverId: string,
    approverEmail: string,
    justification?: string,
  ): Promise<void> {
    return this.decision.approve(requestId, stepIndex, approverId, approverEmail, justification);
  }

  reject(
    requestId: string,
    stepIndex: number,
    approverId: string,
    approverEmail: string,
    justification?: string,
  ): Promise<void> {
    return this.decision.reject(requestId, stepIndex, approverId, approverEmail, justification);
  }

  cancel(requestId: string, requesterId: string): Promise<void> {
    return this.decision.cancel(requestId, requesterId);
  }

  delegate(
    requestId: string,
    stepIndex: number,
    fromApproverId: string,
    fromApproverEmail: string,
    delegateTo: string,
  ): Promise<void> {
    return this.decision.delegate(
      requestId,
      stepIndex,
      fromApproverId,
      fromApproverEmail,
      delegateTo,
    );
  }

  findActiveRequestsForIdentity(identityId: string): Promise<AccessRequestDocument[]> {
    return this.query.findActiveRequestsForIdentity(identityId);
  }

  listMyRequests(
    requesterId: string,
    filters?: { status?: string; page?: number; limit?: number },
  ): Promise<{ data: AccessRequestDocument[]; total: number }> {
    return this.query.listMyRequests(requesterId, filters);
  }

  /** ACTIVE requests past their end date whose removal keeps failing (policy-admin list). */
  listRemovalFailing(filters?: {
    page?: number;
    limit?: number;
  }): Promise<{ data: AccessRequestDocument[]; total: number }> {
    return this.query.listRemovalFailing(filters);
  }

  listPendingApprovals(
    approverId: string,
    approverEmail: string,
  ): Promise<AccessRequestDocument[]> {
    return this.query.listPendingApprovals(approverId, approverEmail);
  }

  getRequestDetail(
    requestId: string,
    requesterId: string,
    requesterEmail: string,
    anyRequest = false,
  ): Promise<AccessRequestDocument> {
    return this.query.getRequestDetail(requestId, requesterId, requesterEmail, anyRequest);
  }

  countPendingApprovals(approverId: string, approverEmail: string): Promise<number> {
    return this.query.countPendingApprovals(approverId, approverEmail);
  }
}
