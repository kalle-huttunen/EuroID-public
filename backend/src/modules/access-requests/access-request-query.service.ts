import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { AccessRequestDocument, ApprovalStep } from './schemas/access-request.schema';
import { AccessRequest, stepRole } from './schemas/access-request.schema';
import { AdminUser, AdminUserDocument } from '../auth/schemas/admin-user.schema';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { paginateQuery } from '@shared/utils/paginate-query';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class AccessRequestQueryService {
  private readonly logger = new Logger(AccessRequestQueryService.name);

  constructor(
    @InjectModel(AccessRequest.name)
    private readonly accessRequestModel: Model<AccessRequestDocument>,
    @InjectModel(AdminUser.name) private readonly adminUsers: Model<AdminUserDocument>,
  ) {}

  /**
   * Requests waiting for approval in every tenant (the euroid_access_requests_pending gauge,
   * read when Prometheus scrapes, outside any tenant context).
   */
  countPendingInAllTenants(): Promise<number> {
    return this.accessRequestModel
      .countDocuments({ status: 'PENDING_APPROVAL' })
      .setOptions({ skipTenantScope: true })
      .exec();
  }

  /**
   * Admin role of the active admin user `email` in the current tenant, or null. ROLE approval
   * steps go to every holder of their role (AdminUser skips the tenant plugin: tenant in filter).
   */
  async approverRoleOf(email: string | undefined): Promise<string | null> {
    if (!email) return null;
    const admin = await this.adminUsers
      .findOne({ tenantId: getCurrentTenantId(), email: email.toLowerCase(), isActive: true })
      .select('role')
      .lean()
      .exec();
    return admin?.role ?? null;
  }

  /** True when the user (id and email as the controller resolves them) may decide the step. */
  isStepApprover(
    step: ApprovalStep,
    approverId: string,
    approverEmail: string,
    role: string | null,
  ): boolean {
    const required = stepRole(step);
    if (required) return role === required;
    return (
      step.approverId === approverId ||
      step.approverEmail?.toLowerCase() === approverEmail?.toLowerCase()
    );
  }

  /**
   * Requests with a step for this approver: named by id or email, or a ROLE step of their role
   * on a request that is neither theirs nor for them (segregation of duties).
   */
  private approverFilter(
    approverId: string,
    approverEmail: string,
    role: string | null,
  ): Record<string, unknown> {
    const or: Record<string, unknown>[] = [
      { 'approvalSteps.approverId': approverId },
      {
        'approvalSteps.approverEmail': {
          $regex: `^${escapeRegex(approverEmail || '')}$`,
          $options: 'i',
        },
      },
    ];
    if (role) {
      or.push({
        requesterId: { $ne: approverId },
        targetIdentityId: { $ne: approverId },
        approvalSteps: {
          $elemMatch: { approverType: 'ROLE', approverId: role, delegatedFrom: null },
        },
      });
    }
    return { $or: or };
  }

  /**
   * Access requests in force (ACTIVE) or being given (PROVISIONING) for an identity: those whose
   * access is for it (targetIdentityId; a request stored without one is for its requester), never
   * a manager's requests for a direct report. Read by the offboarding impact preview and by
   * GET /identity/:id/entitlements.
   */
  async findActiveRequestsForIdentity(identityId: string): Promise<AccessRequestDocument[]> {
    const tenantId = getCurrentTenantId();
    return this.accessRequestModel
      .find({
        tenantId,
        $or: [
          { targetIdentityId: identityId },
          { targetIdentityId: null, requesterId: identityId },
        ],
        status: { $in: ['ACTIVE', 'PROVISIONING'] },
      })
      .lean()
      .exec() as Promise<AccessRequestDocument[]>;
  }

  async listMyRequests(
    requesterId: string,
    filters?: { status?: string; page?: number; limit?: number },
  ): Promise<{ data: AccessRequestDocument[]; total: number }> {
    const tenantId = getCurrentTenantId();
    const q: Record<string, unknown> = { tenantId, requesterId };
    if (filters?.status) q.status = filters.status;

    const page = Math.max(1, filters?.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters?.limit ?? 20));
    const skip = (page - 1) * limit;

    const result = await paginateQuery(this.accessRequestModel, q, {
      skip,
      limit,
      sort: { createdAt: -1 },
    });

    return { data: result.items as AccessRequestDocument[], total: result.total };
  }

  /**
   * Requests whose removal keeps failing, tenant-wide (the policy-admin list): ACTIVE, the end
   * date (`expiresAt`, else `timeConstraint.expiresAt`) passed, and a reason recorded
   * (`statusReason`, which the revoke sets when Graph refuses the removal or a removal fails on an
   * answer retrying can fix, and clears when an attempt succeeds). Ordered by `expiresAt`, the oldest first (one with only
   * `timeConstraint.expiresAt` before those): the admin closes each by hand on its page
   * (POST /access-requests/:id/removed-manually) once the access is removed.
   */
  async listRemovalFailing(
    filters: { page?: number; limit?: number } = {},
    now = new Date(),
  ): Promise<{ data: AccessRequestDocument[]; total: number }> {
    const q = {
      tenantId: getCurrentTenantId(),
      status: 'ACTIVE',
      statusReason: { $exists: true, $nin: [null, ''] },
      $or: [
        { expiresAt: { $lte: now } },
        { expiresAt: null, 'timeConstraint.expiresAt': { $lte: now } },
      ],
    };
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20));
    const result = await paginateQuery(this.accessRequestModel, q, {
      skip: (page - 1) * limit,
      limit,
      sort: { expiresAt: 1, 'timeConstraint.expiresAt': 1 },
    });
    return { data: result.items as AccessRequestDocument[], total: result.total };
  }

  /**
   * The pending requests waiting for this approver now: the request's current step (its first
   * PENDING one) is theirs. A ROLE step is never the requester's or the beneficiary's (segregation
   * of duties). The list and its badge count (countPendingApprovals) are this one set.
   */
  async listPendingApprovals(
    approverId: string,
    approverEmail: string,
  ): Promise<AccessRequestDocument[]> {
    const tenantId = getCurrentTenantId();
    const role = await this.approverRoleOf(approverEmail);
    const docs = await this.accessRequestModel
      .find({
        tenantId,
        status: 'PENDING_APPROVAL',
        ...this.approverFilter(approverId, approverEmail, role),
        'approvalSteps.status': 'PENDING',
      })
      .sort({ createdAt: 1 })
      .exec();
    return docs.filter((d) => {
      const current = d.approvalSteps.find((s) => s.status === 'PENDING');
      if (!current) return false;
      const ownRequest = d.requesterId === approverId || d.targetIdentityId === approverId;
      if (stepRole(current) && ownRequest) return false;
      return this.isStepApprover(current, approverId, approverEmail, role);
    });
  }

  /**
   * The request for its requester or one of its approvers; `anyRequest` (a policy-admin, who
   * closes a request as removed by hand) opens any request of the tenant.
   */
  async getRequestDetail(
    requestId: string,
    requesterId: string,
    requesterEmail: string,
    anyRequest = false,
  ): Promise<AccessRequestDocument> {
    const tenantId = getCurrentTenantId();
    const doc = await this.accessRequestModel.findOne({ requestId, tenantId }).exec();
    if (!doc) throw new NotFoundException('Access request not found');
    if (anyRequest) return doc;

    const isRequester =
      doc.requesterId === requesterId ||
      doc.requesterEmail?.toLowerCase() === requesterEmail?.toLowerCase();
    const steps = doc.approvalSteps ?? [];
    const role = steps.some((s) => stepRole(s)) ? await this.approverRoleOf(requesterEmail) : null;
    const isApprover = steps.some((s) => this.isStepApprover(s, requesterId, requesterEmail, role));
    if (!isRequester && !isApprover) {
      throw new ForbiddenException(
        'You can only view your own requests or requests you are designated to approve',
      );
    }
    return doc;
  }

  /** The sidebar badge: the number of requests listPendingApprovals lists. */
  async countPendingApprovals(approverId: string, approverEmail: string): Promise<number> {
    return (await this.listPendingApprovals(approverId, approverEmail)).length;
  }
}
