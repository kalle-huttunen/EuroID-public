import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SodPolicy, SodPolicyDocument, SodEntitlementRef } from './schemas/sod-policy.schema';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { toOperationType } from '@shared/utils/entitlement-operation-type';
import { systemKey } from '@shared/utils/normalize-system-name';
import type { CreateSodPolicyDto } from './dtos/create-sod-policy.dto';
import type { UpdateSodPolicyDto } from './dtos/update-sod-policy.dto';

/** Result of a SoD policy violation. */
export interface SodViolation {
  policyName: string;
  severity: string;
  action: 'BLOCK' | 'WARN';
  conflictingEntitlements: SodEntitlementRef[];
}

/** Structured result of SoD validation — caller decides whether to throw or continue. */
export interface SoDValidationResult {
  passed: boolean;
  blockers: SodViolation[];
  warnings: SodViolation[];
}

/** Convert raw violations to structured result. */
export function toSoDValidationResult(violations: SodViolation[]): SoDValidationResult {
  const blockers = violations.filter((v) => v.action === 'BLOCK');
  const warnings = violations.filter((v) => v.action === 'WARN');
  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
  };
}

/** Minimal operation shape for SoD validation (avoids circular dep with policy-engine). */
export interface SodProvisioningOp {
  target: string;
  type: string;
  targetId: string;
  action: 'add' | 'remove' | 'set';
}

/** A system and the id an operation or an SoD policy names an entitlement by there. */
export interface SodTarget {
  system: string;
  targetId: string;
}

/** How validate() reads the operations; without options every match of the operations counts. */
export interface SodValidateOptions {
  /**
   * Only a policy match that includes one of these operations counts (an access request's
   * entitlements): a conflict the other operations already make by themselves is left out.
   */
  involving?: SodProvisioningOp[];
  /**
   * The one id of each target (a catalog native id), for operations and policy entitlements that
   * name an entitlement in different forms (a rule by display name, a request by native id).
   * Undefined for a target it does not know: that target matches its own id only.
   */
  resolveTargets?: (targets: SodTarget[]) => Promise<(target: SodTarget) => string | undefined>;
}

/** Serialized SoD policy response shape */
export interface SodPolicyResponse {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  severity: string;
  conflictingEntitlements: SodEntitlementRef[];
  isActive: boolean;
  action: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * SoD policy service — CRUD + validation.
 * Manages toxic entitlement combinations for Segregation of Duties.
 */
@Injectable()
export class SodService {
  constructor(
    @InjectModel(SodPolicy.name)
    private readonly sodPolicyModel: Model<SodPolicyDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  // ── CRUD ────────────────────────────────────────────

  async findAll(tenantId: string): Promise<SodPolicyResponse[]> {
    const docs = await this.sodPolicyModel.find({ tenantId }).sort({ createdAt: -1 }).lean().exec();
    return docs.map((doc) => this.toResponse(doc as unknown as Record<string, unknown>));
  }

  async create(tenantId: string, dto: CreateSodPolicyDto): Promise<SodPolicyResponse> {
    const doc = await this.sodPolicyModel.create({ ...dto, tenantId });
    const response = this.toResponse(doc.toObject() as unknown as Record<string, unknown>);

    this.eventEmitter.emit(DomainEventType.SOD_POLICY_CREATED, response.id, {
      tenantId,
      name: dto.name,
      action: dto.action,
      severity: dto.severity,
    });

    return response;
  }

  async update(id: string, tenantId: string, dto: UpdateSodPolicyDto): Promise<SodPolicyResponse> {
    const doc = await this.sodPolicyModel
      .findOneAndUpdate({ _id: id, tenantId }, { $set: dto }, { new: true })
      .exec();
    if (!doc) throw new NotFoundException(`SoD policy ${id} not found`);
    const response = this.toResponse(doc.toObject() as unknown as Record<string, unknown>);

    this.eventEmitter.emit(DomainEventType.SOD_POLICY_UPDATED, id, {
      tenantId,
      changes: Object.keys(dto),
    });

    return response;
  }

  async remove(id: string, tenantId: string): Promise<{ id: string; isActive: boolean }> {
    const doc = await this.sodPolicyModel
      .findOneAndUpdate({ _id: id, tenantId }, { $set: { isActive: false } }, { new: true })
      .exec();
    if (!doc) throw new NotFoundException(`SoD policy ${id} not found`);

    this.eventEmitter.emit(DomainEventType.SOD_POLICY_DELETED, id, { tenantId });

    return { id: doc._id.toString(), isActive: false };
  }

  // ── Validation ──────────────────────────────────────

  /**
   * Validates a set of provisioning operations against active SoD policies.
   * Returns an array of violations (empty if clean).
   */
  async validate(
    tenantId: string,
    operations: SodProvisioningOp[],
    options: SodValidateOptions = {},
  ): Promise<SodViolation[]> {
    const policies = await this.sodPolicyModel.find({ tenantId, isActive: true }).exec();

    const keyOf = await this.targetKeys(policies, operations, options);
    const violations: SodViolation[] = [];

    for (const policy of policies) {
      if (!policy.conflictingEntitlements?.length) continue;

      const matched = policy.conflictingEntitlements.every((ref) =>
        operations.some((op) => this.opMatchesRef(op, ref, keyOf)),
      );
      const involved =
        !options.involving ||
        policy.conflictingEntitlements.some((ref) =>
          options.involving!.some((op) => this.opMatchesRef(op, ref, keyOf)),
        );

      if (matched && involved) {
        violations.push({
          policyName: policy.name,
          severity: policy.severity,
          action: policy.action,
          conflictingEntitlements: policy.conflictingEntitlements,
        });
      }
    }

    return violations;
  }

  // ── Private ─────────────────────────────────────────

  /** The id each target is compared by: its resolved id (resolveTargets), else its own. */
  private async targetKeys(
    policies: SodPolicyDocument[],
    operations: SodProvisioningOp[],
    options: SodValidateOptions,
  ): Promise<(target: SodTarget) => string> {
    const { resolveTargets } = options;
    if (!resolveTargets || policies.length === 0) return (t) => t.targetId;
    const targets: SodTarget[] = [
      ...[...operations, ...(options.involving ?? [])].map((op) => ({
        system: op.target,
        targetId: op.targetId,
      })),
      ...policies.flatMap((p) =>
        (p.conflictingEntitlements ?? []).map((r) => ({ system: r.system, targetId: r.targetId })),
      ),
    ];
    const resolved = await resolveTargets(targets);
    return (t) => resolved(t) ?? t.targetId;
  }

  /**
   * Type through toOperationType: a stored `directoryrole` and a `DirectoryRole` match `role`.
   * System through systemKey, as the policy engine names systems (`entra` is entra-id,
   * `active-directory` is ad); an operation on target `all` matches a policy on any system. Id
   * as `keyOf` gives it (the resolved id when validate() was given resolveTargets).
   */
  private opMatchesRef(
    op: SodProvisioningOp,
    ref: SodEntitlementRef,
    keyOf: (target: SodTarget) => string,
  ): boolean {
    if (op.action !== 'add') return false;

    const target = systemKey(op.target);
    const targetMatch = target === 'all' || target === systemKey(ref.system);
    const typeMatch =
      !!op.type && !!ref.type && toOperationType(op.type) === toOperationType(ref.type);
    // An operation on `all` is resolved on the policy's system
    const opSystem = target === 'all' ? ref.system : op.target;
    const targetIdMatch =
      op.targetId === ref.targetId ||
      keyOf({ system: opSystem, targetId: op.targetId }) ===
        keyOf({ system: ref.system, targetId: ref.targetId });

    return targetMatch && typeMatch && targetIdMatch;
  }

  private toResponse(doc: Record<string, unknown>): SodPolicyResponse {
    const typed = doc as unknown as SodPolicy & {
      _id: { toString(): string };
      createdAt?: Date;
      updatedAt?: Date;
    };
    return {
      id: typed._id.toString(),
      tenantId: typed.tenantId,
      name: typed.name,
      description: typed.description,
      severity: typed.severity,
      conflictingEntitlements: typed.conflictingEntitlements,
      isActive: typed.isActive,
      action: typed.action,
      createdAt: typed.createdAt,
      updatedAt: typed.updatedAt,
    };
  }
}
