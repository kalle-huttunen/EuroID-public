import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Policy, PolicyDocument, PolicyStatus } from './schemas/policy.schema';
import { EntitlementCatalogService } from '../entitlement-catalog/entitlement-catalog.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { isSafeRegex } from '@shared/utils/safe-regex.util';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';

const ENTRA_SYSTEM = 'entra-id';

/**
 * CRUD for Policies. Registers policy groups in Entra for conflict resolution; feeds PolicyEngineService.
 */
@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(
    @InjectModel(Policy.name) private readonly policyModel: Model<PolicyDocument>,
    private readonly entitlementCatalog: EntitlementCatalogService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  // ── CRUD ────────────────────────────────────────────────────────────

  async create(dto: Partial<Policy>, actor?: string): Promise<PolicyDocument> {
    this.logger.log(`Creating policy: ${dto.name}`);
    this.validateRegexConditions(dto);

    // SoD: Force DRAFT status — policies must be activated by a different admin
    dto.status = PolicyStatus.DRAFT;
    if (actor) {
      dto.createdBy = actor;
    }

    const doc = await this.policyModel.create(dto);
    await this.registerPolicyGroupsForEntra(doc);

    const policyId = doc._id.toString();
    this.eventEmitter.emit(DomainEventType.POLICY_CREATED, policyId, {
      policyId,
      name: doc.name,
      createdBy: actor || 'admin',
    });

    return doc;
  }

  async findAll(): Promise<PolicyDocument[]> {
    return this.policyModel.find().sort({ priority: 1, createdAt: -1 }).exec();
  }

  async findActive(): Promise<PolicyDocument[]> {
    return this.policyModel.find({ status: PolicyStatus.ACTIVE }).sort({ priority: 1 }).exec();
  }

  async findOne(id: string): Promise<PolicyDocument> {
    const policy = await this.policyModel.findById(id).exec();
    if (!policy) throw new NotFoundException(`Policy ${id} not found`);
    return policy;
  }

  async update(id: string, dto: Partial<Policy>, actor?: string): Promise<PolicyDocument> {
    this.logger.log(`Updating policy: ${id}`);
    this.validateRegexConditions(dto);
    const policy = await this.policyModel.findById(id).exec();
    if (!policy) throw new NotFoundException(`Policy ${id} not found`);

    const safeDto: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) {
      if (k !== '_id' && v !== undefined) {
        safeDto[k] = v;
      }
    }
    // SoD: status changes must go through toggle or activate endpoints, and who created or last
    // edited the grants is recorded here, never taken from the input
    delete safeDto.status;
    delete safeDto.createdBy;
    delete safeDto.lastEditedBy;
    delete safeDto.lastEditedAt;

    // PE-1: a change of conditions, actions or role bundle needs a second policy-admin again
    // (activate). Any policy that is not a draft goes back to DRAFT: a DISABLED one too, which
    // could otherwise be toggled back to ACTIVE with the unreviewed change.
    const conditionsOrActionsUpdated =
      dto.conditionGroups !== undefined ||
      dto.actions !== undefined ||
      dto.roleBundleId !== undefined;
    if (policy.status !== PolicyStatus.DRAFT && conditionsOrActionsUpdated) {
      (safeDto as Record<string, unknown>).status = PolicyStatus.DRAFT;
      this.logger.log(
        `Policy ${id}: conditions/actions/roleBundleId changed on a ${policy.status} policy: ` +
          'set to DRAFT; activation by a second policy-admin required.',
      );
    }
    // The editor of the grants may not activate them (activate); an unknown one is recorded as
    // such, so no unknown activator can approve that change either
    if (conditionsOrActionsUpdated) {
      safeDto.lastEditedBy = actor || 'unknown';
      safeDto.lastEditedAt = new Date();
    }

    Object.assign(policy, safeDto);
    const updated = await policy.save();

    await this.registerPolicyGroupsForEntra(updated);

    const dtoRecord = dto as Record<string, unknown>;
    const changedFields = Object.keys(dtoRecord).filter(
      (k) => k !== '_id' && dtoRecord[k] !== undefined,
    );
    this.eventEmitter.emit(DomainEventType.POLICY_UPDATED, id, {
      policyId: id,
      changedFields: changedFields.length > 0 ? changedFields : Object.keys(dtoRecord),
    });

    return updated;
  }

  /** Validate regex conditions for ReDoS safety. Throws BadRequestException if unsafe. */
  validateRegexConditions(dto: Partial<Policy> | Record<string, unknown>): void {
    const groups = (dto as Record<string, unknown>).conditionGroups;
    if (!Array.isArray(groups)) return;
    for (const group of groups) {
      const conditions = (group as Record<string, unknown>)?.conditions;
      if (!Array.isArray(conditions)) continue;
      for (const cond of conditions) {
        const c = cond as Record<string, unknown>;
        if (c.operator === 'regex' && c.value) {
          const pattern = String(c.value);
          if (!isSafeRegex(pattern)) {
            throw new BadRequestException(
              `Regex pattern "${pattern}" is unsafe (ReDoS risk). Use simpler patterns.`,
            );
          }
        }
      }
    }
  }

  /** Register assign_group (Entra) groups as POLICY in the entitlement catalog (Hybrid Governance). */
  private async registerPolicyGroupsForEntra(policy: PolicyDocument): Promise<void> {
    if (!policy.actions?.length) return;
    for (const action of policy.actions) {
      if (action.type !== 'assign_group') continue;
      const target = String(action.target || '').toLowerCase();
      if (target !== 'entra-id' && target !== 'entra' && target !== 'all') continue;
      const groupName = action.params?.groupName;
      if (groupName && String(groupName).trim()) {
        await this.entitlementCatalog.registerPolicyGroup(ENTRA_SYSTEM, String(groupName).trim());
        this.logger.debug(`[Policy] Registered POLICY group for Entra: ${groupName}`);
      }
    }
  }

  async remove(id: string, _actor?: string): Promise<void> {
    this.logger.log(`Deleting policy: ${id}`);
    const result = await this.policyModel.findByIdAndDelete(id).exec();
    if (!result) throw new NotFoundException(`Policy ${id} not found`);

    this.eventEmitter.emit(DomainEventType.POLICY_DELETED, id, {
      policyId: id,
      name: result.name,
    });
  }

  // ── Toggle Status ───────────────────────────────────────────────────

  async toggleStatus(id: string, _actor?: string): Promise<PolicyDocument> {
    const policy = await this.findOne(id);

    // DRAFT policies must use the activate endpoint (SoD peer-review)
    if (policy.status === PolicyStatus.DRAFT) {
      throw new BadRequestException(
        'Draft policies cannot be toggled. Use the activate endpoint for peer-reviewed activation.',
      );
    }

    const newStatus =
      policy.status === PolicyStatus.ACTIVE ? PolicyStatus.DISABLED : PolicyStatus.ACTIVE;

    this.logger.log(`Toggling policy ${id}: ${policy.status} → ${newStatus}`);
    policy.status = newStatus;
    const saved = await policy.save();

    this.eventEmitter.emit(DomainEventType.POLICY_UPDATED, id, {
      policyId: id,
      changedFields: ['status'],
    });

    return saved;
  }

  // ── Activate (SoD peer-review) ───────────────────────────────────────

  async activate(id: string, activatedBy: string): Promise<PolicyDocument> {
    const policy = await this.findOne(id);

    if (policy.status === PolicyStatus.ACTIVE) {
      throw new BadRequestException(`Policy ${id} is already active`);
    }
    if (policy.status === PolicyStatus.TESTING) {
      throw new BadRequestException(`Policy ${id} is in testing — complete testing first`);
    }

    // SoD: who wrote the current grants cannot activate them: the last editor of the
    // conditions, actions or role bundle, or for a policy never so edited its creator. 'system'
    // (seeded policies) is exempt.
    if (policy.lastEditedBy) {
      if (policy.lastEditedBy !== 'system' && policy.lastEditedBy === activatedBy) {
        throw new ForbiddenException(
          "Segregation of Duties: The last editor of a policy's conditions, actions or role " +
            'bundle cannot activate it. A different policy-admin must review and activate.',
        );
      }
    } else if (
      policy.createdBy &&
      policy.createdBy !== 'system' &&
      policy.createdBy === activatedBy
    ) {
      throw new ForbiddenException(
        'Segregation of Duties: The policy creator cannot activate their own policy. A different policy-admin must review and activate.',
      );
    }

    const previousStatus = policy.status;
    this.logger.log(`Activating policy ${id} (by ${activatedBy}, created by ${policy.createdBy})`);
    policy.status = PolicyStatus.ACTIVE;
    const saved = await policy.save();

    // Who activated it is the event's actor (the audit entry's actor), kept out of the payload,
    // which also reaches the tenant websocket.
    this.eventEmitter.emit(
      DomainEventType.POLICY_UPDATED,
      id,
      { policyId: id, changedFields: ['status'], previousStatus },
      { actor: activatedBy },
    );

    return saved;
  }

  // ── Reorder Priorities ──────────────────────────────────────────────

  async reorderPriorities(orderedIds: string[], _actor?: string): Promise<void> {
    this.logger.log(`Reordering ${orderedIds.length} policies`);
    const tenantId = getRequestContext()?.tenantId || 'default';

    // Verify all policy IDs belong to the requesting tenant before bulkWrite
    const ownedCount = await this.policyModel.countDocuments({
      _id: { $in: orderedIds },
      tenantId,
    });
    if (ownedCount !== orderedIds.length) {
      throw new ForbiddenException('One or more policy IDs do not belong to the current tenant.');
    }

    const bulkOps = orderedIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id, tenantId },
        update: { $set: { priority: index + 1 } },
      },
    }));
    await this.policyModel.bulkWrite(bulkOps);
  }

  // ── Increment execution counter ────────────────────────────────────

  async recordExecution(id: string, affectedCount: number): Promise<void> {
    await this.policyModel.findByIdAndUpdate(id, {
      $inc: { totalExecutions: 1 },
      $set: { lastTriggered: new Date(), affectedUsers: affectedCount },
    });
  }
}
