/**
 * Agents whose owner left. When the owner is offboarded (or deleted from the hub) the owner's
 * agents that are not revoked are marked ownerless (NhiOwnerLeftHandler); a GDPR erasure marks
 * them `erased` through markOwnerless too (GdprErasureService), then redacts the owner email of
 * every agent of the owner (gdpr-erasure-scope.ts). An ownerless agent gets no new credential
 * (NhiCredentialService), while credentials issued before keep verifying, so an integration does
 * not break silently. Each mark writes a warning audit entry and emits nhi.owner_lost (webhooks),
 * asking a person to give the agent a new owner (reown) or revoke it.
 */
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { AuditService } from '../audit/audit.service';
import { NhiService } from './nhi.service';
import {
  AgentIdentity,
  type AgentIdentityDocument,
  type OwnerlessReason,
} from './schemas/agent-identity.schema';

const SYSTEM_ACTOR = 'nhi-ownership';

@Injectable()
export class NhiOwnershipService {
  private readonly logger = new Logger(NhiOwnershipService.name);

  constructor(
    @InjectModel(AgentIdentity.name)
    private readonly agentModel: Model<AgentIdentityDocument>,
    private readonly nhi: NhiService,
    private readonly auditService: AuditService,
    private readonly events: DomainEventEmitterService,
  ) {}

  /**
   * Marks the agents `ownerIdentityId` owns in the tenant, and that are not revoked and not
   * marked yet, ownerless; one audit entry and one nhi.owner_lost each. Answers how many.
   */
  async markOwnerless(
    tenantId: string,
    ownerIdentityId: string,
    reason: OwnerlessReason,
  ): Promise<number> {
    let marked = 0;
    // One at a time, each claimed by its own conditional write: a second signal for the same
    // owner (offboarding also deletes the identity) finds nothing left to mark
    for (;;) {
      const doc = await this.agentModel
        .findOneAndUpdate(
          {
            tenantId,
            'owner.identityId': ownerIdentityId,
            status: { $ne: 'revoked' },
            ownerlessSince: { $exists: false },
          },
          { $set: { ownerlessSince: new Date(), ownerlessReason: reason } },
          { new: true },
        )
        .exec();
      if (!doc) break;
      marked += 1;
      await this.audit(tenantId, SYSTEM_ACTOR, doc, 'AGENT_IDENTITY_OWNERLESS', 'warning', {
        ownerIdentityId,
        reason,
      });
      this.events.emit(
        DomainEventType.NHI_OWNER_LOST,
        doc.agentId,
        { agentId: doc.agentId, ownerIdentityId, reason },
        { tenantId, actor: SYSTEM_ACTOR },
      );
    }
    if (marked > 0) {
      this.logger.warn(`Owner ${ownerIdentityId} ${reason}: ${marked} agent(s) now ownerless`);
    }
    return marked;
  }

  /**
   * Gives the agent a new owner, who must be an active identity of the tenant (400 otherwise);
   * an ownerless agent is no longer ownerless. A revoked agent keeps its owner (409).
   */
  async reown(
    tenantId: string,
    agentId: string,
    ownerIdentityId: string,
    actor: string,
  ): Promise<AgentIdentityDocument> {
    const doc = await this.nhi.mustGet(tenantId, agentId);
    if (doc.status === 'revoked') {
      throw new ConflictException(`Agent '${agentId}' is revoked: its owner does not change`);
    }
    await this.nhi.assertOwnerActive(tenantId, ownerIdentityId);
    const email = await this.nhi.ownerEmail(tenantId, ownerIdentityId);

    const previousOwnerIdentityId = doc.owner.identityId;
    doc.owner = { identityId: ownerIdentityId, email };
    doc.ownerlessSince = undefined;
    doc.ownerlessReason = undefined;
    await doc.save();

    await this.audit(tenantId, actor, doc, 'AGENT_IDENTITY_OWNER_CHANGED', 'info', {
      previousOwnerIdentityId,
      ownerIdentityId,
    });
    this.events.emit(
      DomainEventType.NHI_OWNER_CHANGED,
      doc.agentId,
      { agentId: doc.agentId, previousOwnerIdentityId, ownerIdentityId },
      { tenantId, actor },
    );
    return doc;
  }

  private async audit(
    tenantId: string,
    actor: string,
    doc: AgentIdentityDocument,
    action: string,
    severity: 'info' | 'warning',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.auditService.log({
      action: action as never,
      severity,
      actor,
      resourceType: 'agent-identity',
      resourceId: doc.agentId,
      resourceName: doc.displayName,
      description: `${action} ${doc.agentId} (${doc.kind})`,
      payload: { metadata },
      tenantId,
    });
  }
}
