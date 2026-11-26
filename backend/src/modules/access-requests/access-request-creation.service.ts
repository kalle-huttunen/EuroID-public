import {
  Inject,
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import type {
  AccessRequestDocument,
  AccessRequestEntitlement,
} from './schemas/access-request.schema';
import { AccessRequest } from './schemas/access-request.schema';
import { type CreateAccessRequestDto } from './dtos/create-access-request.dto';
import { type PreCheckSodDto } from './dtos/pre-check-sod.dto';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { IDENTITY_QUERY_PORT, IIdentityQueryPort } from '@shared/interfaces/identity-query.port';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { accessRequestApprovalWorkflow } from '../../workflows/access-request-approval.workflow';
import type { EntitlementCatalogDocument } from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import {
  type AccessRequestsConfig,
  accessRequestsConfig,
} from '@infrastructure/config/access-requests.config';
import { maskEmail } from '../identity/identity-pii';
import { getSystemType } from '@shared/utils/normalize-system-name';
import { mergeApprovalChains, resolveApprovalSteps } from './approval-chain';
import {
  AccessRequestSodService,
  toViolationRefs,
  type IdentityLike,
} from './access-request-sod.service';

@Injectable()
export class AccessRequestCreationService {
  private readonly logger = new Logger(AccessRequestCreationService.name);

  constructor(
    @InjectModel(AccessRequest.name)
    private readonly accessRequestModel: Model<AccessRequestDocument>,
    private readonly entitlementCatalog: EntitlementCatalogService,
    private readonly accessRequestSod: AccessRequestSodService,
    @Inject(IDENTITY_QUERY_PORT) private readonly identityQuery: IIdentityQueryPort,
    private readonly temporalClient: TemporalClientProvider,
    private readonly eventEmitter: DomainEventEmitterService,
    @Inject(accessRequestsConfig.KEY) private readonly arConf: AccessRequestsConfig,
  ) {}

  async createRequest(
    dto: CreateAccessRequestDto,
    requesterId: string,
    requesterEmail: string,
  ): Promise<AccessRequestDocument> {
    const tenantId = getCurrentTenantId();

    const catalogEntries = await this.validateAndLoadCatalogEntries(tenantId, dto.entitlements);

    const { targetIdentityId, identity } = await this.loadTarget(
      dto.targetIdentityId,
      requesterId,
      requesterEmail,
    );

    const entitlements: AccessRequestEntitlement[] = dto.entitlements.map((item, i) => {
      const entry = catalogEntries[i];
      return {
        catalogEntryId: item.catalogEntryId,
        system: entry.system,
        entitlementName: entry.name,
        nativeId: entry.nativeId,
        entitlementType: entry.type,
        justification: item.justification,
      };
    });

    const { blockers, warnings } = await this.accessRequestSod.check(
      tenantId,
      targetIdentityId,
      entitlements,
    );

    if (blockers.length > 0) {
      throw new BadRequestException({
        message: 'SoD violation: request conflicts with segregation of duties policies',
        sodViolations: blockers.map((v) => ({
          policyName: v.policyName,
          severity: v.severity,
          conflictingEntitlements: v.conflictingEntitlements.map(
            (e) => `${e.system}:${e.targetId}`,
          ),
        })),
      });
    }

    // No blockers here: what is stored are the Warn matches, shown to the reviewers
    const sodCheckResult = { passed: true, violations: toViolationRefs(warnings) };

    const target = ((identity as IdentityLike).profile ?? identity) as Record<string, unknown>;
    const approvalSteps = await resolveApprovalSteps(
      mergeApprovalChains(catalogEntries),
      catalogEntries,
      {
        requesterId,
        requesterEmail,
        targetIdentityId,
        targetEmail: target.email as string | undefined,
        managerEmail: target.managerEmail as string | undefined,
      },
      async (email) => {
        const found = await this.identityQuery.findByEmail(email);
        return found?._id ? String(found._id) : undefined;
      },
      new Date(),
    );

    let expiresAt: Date | undefined;
    if (dto.requestedDurationDays) {
      const maxDays = Math.min(
        ...catalogEntries.map((e) => e.maxDurationDays ?? 365).filter(Boolean),
      );
      const days = Math.min(dto.requestedDurationDays, maxDays);
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + days);
    }

    const requestId = randomUUID();
    const workflowId = `access-request-${requestId}`;

    const doc = await this.accessRequestModel.create({
      tenantId,
      requestId,
      requesterId,
      requesterEmail,
      targetIdentityId,
      entitlements,
      status: 'PENDING_APPROVAL',
      approvalSteps,
      timeConstraint: dto.requestedDurationDays
        ? { requestedDurationDays: dto.requestedDurationDays, expiresAt }
        : undefined,
      sodCheckResult,
      workflowId,
    });

    try {
      await this.temporalClient.getClient().workflow.start(accessRequestApprovalWorkflow, {
        taskQueue: DEFAULT_PROVISIONING_QUEUE,
        workflowId,
        args: [{ requestId, tenantId, approvalTimeoutDays: this.arConf.approvalTimeoutDays }],
        // Like every tenant workflow: the dev tools list and read workflows by this attribute.
        searchAttributes: { TenantId: [tenantId] },
      });
    } catch (err: unknown) {
      await this.accessRequestModel.updateOne({ requestId }, { $set: { status: 'FAILED' } }).exec();
      this.logger.error(
        `[AccessRequest] Failed to start workflow for ${requestId}: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }

    // No address (audit log, websocket, webhooks): a requester without an identity is known by
    // their email, so requesterId is left out then
    this.eventEmitter.emit(DomainEventType.ACCESS_REQUEST_CREATED, requestId, {
      requestId,
      ...(requesterId !== requesterEmail ? { requesterId } : {}),
      status: 'PENDING_APPROVAL',
    });

    this.logger.log(`[AccessRequest] Created ${requestId} for ${maskEmail(requesterEmail)}`);
    return doc;
  }

  /**
   * Pre-check SoD violations without creating a request.
   * Returns blockers and warnings so the user can acknowledge before submitting.
   */
  async preCheckSod(
    dto: PreCheckSodDto,
    requesterId: string,
    requesterEmail: string,
  ): Promise<{
    blockers: Array<{ policyName: string; severity: string; conflictingEntitlements: string[] }>;
    warnings: Array<{ policyName: string; severity: string; conflictingEntitlements: string[] }>;
  }> {
    const tenantId = getCurrentTenantId();

    const catalogEntries = await this.validateAndLoadCatalogEntries(tenantId, dto.entitlements);

    const { targetIdentityId } = await this.loadTarget(
      dto.targetIdentityId,
      requesterId,
      requesterEmail,
    );

    const entitlements: AccessRequestEntitlement[] = dto.entitlements.map((item, i) => {
      const entry = catalogEntries[i];
      return {
        catalogEntryId: item.catalogEntryId,
        system: entry.system,
        entitlementName: entry.name,
        nativeId: entry.nativeId,
        entitlementType: entry.type,
        justification: '',
      };
    });

    const { blockers, warnings } = await this.accessRequestSod.check(
      tenantId,
      targetIdentityId,
      entitlements,
    );

    return {
      blockers: blockers.map((v) => ({
        policyName: v.policyName,
        severity: v.severity,
        conflictingEntitlements: v.conflictingEntitlements.map((e) => `${e.system}:${e.targetId}`),
      })),
      warnings: warnings.map((v) => ({
        policyName: v.policyName,
        severity: v.severity,
        conflictingEntitlements: v.conflictingEntitlements.map((e) => `${e.system}:${e.targetId}`),
      })),
    };
  }

  /**
   * The person the access is for: `targetIdentityId`, else the requester. A requester without an
   * identity (an admin known by their email, AccessRequestsController.resolveRequesterId) cannot
   * be given access, so they must name the person (400). Only the person's manager may ask on
   * their behalf (403).
   */
  private async loadTarget(
    target: string | undefined,
    requesterId: string,
    requesterEmail: string,
  ): Promise<{ targetIdentityId: string; identity: Record<string, unknown> }> {
    if (!target && requesterId === requesterEmail) {
      throw new BadRequestException(
        'You have no identity in the directory, so access cannot be given to you. To request ' +
          'access for a person, name them (targetIdentityId).',
      );
    }
    const targetIdentityId = target ?? requesterId;
    const identity = await this.identityQuery.findById(targetIdentityId);
    if (!identity) {
      throw new BadRequestException('Target identity not found');
    }
    this.assertOnBehalfOfAllowed(identity, targetIdentityId, requesterId, requesterEmail);
    return { targetIdentityId, identity };
  }

  private assertOnBehalfOfAllowed(
    identity: unknown,
    targetIdentityId: string,
    requesterId: string,
    requesterEmail: string,
  ): void {
    if (targetIdentityId === requesterId) return;
    const typedIdentity = identity as IdentityLike;
    const targetProfile = typedIdentity.profile ?? typedIdentity;
    const managerEmail = (targetProfile as Record<string, unknown>).managerEmail as
      | string
      | undefined;
    if (!managerEmail || managerEmail.toLowerCase() !== requesterEmail.toLowerCase()) {
      throw new ForbiddenException('You can only request access on behalf of your direct reports');
    }
  }

  private async validateAndLoadCatalogEntries(
    tenantId: string,
    items: Array<{ catalogEntryId: string }>,
  ): Promise<EntitlementCatalogDocument[]> {
    const catalogEntries: EntitlementCatalogDocument[] = [];
    for (const item of items) {
      const entry = await this.entitlementCatalog.findCatalogEntryById(
        tenantId,
        item.catalogEntryId,
      );
      if (!entry) {
        throw new BadRequestException(
          `Entitlement catalog entry not found: ${item.catalogEntryId}`,
        );
      }
      if (!entry.requestable) {
        throw new BadRequestException(`Entitlement ${entry.name} is not requestable`);
      }
      // Fulfilment (AccessRequestActivities.provisionAccessRequest) grants Entra ID only
      if (getSystemType(entry.system) !== 'entra') {
        throw new BadRequestException(
          `Entitlement ${entry.name} is in ${entry.system}: access requests can grant Entra ID ` +
            'entitlements only',
        );
      }
      catalogEntries.push(entry);
    }
    return catalogEntries;
  }
}
