import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { RoleBundle, RoleBundleAction, RoleBundleDocument } from './schemas/role-bundle.schema';
import { Policy, PolicyDocument, PolicyStatus } from '../policy/schemas/policy.schema';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { PolicyUpdatedPayload } from '@infrastructure/events/event-payloads';

/** Levels of parents resolveWithInheritance follows below a policy's bundle. */
const MAX_INHERITANCE_DEPTH = 5;

/** Lean representation of a RoleBundle with a string `id` field. */
export interface RoleBundleLean extends Omit<RoleBundle, 'actions'> {
  _id: unknown;
  id?: string;
  actions: RoleBundleAction[];
}

/**
 * CRUD for role bundles. Reusable action sets used by policies.
 */
@Injectable()
export class RoleBundlesService {
  constructor(
    @InjectModel(RoleBundle.name) private readonly roleBundleModel: Model<RoleBundleDocument>,
    @InjectModel(Policy.name) private readonly policyModel: Model<PolicyDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  async create(
    payload: {
      name: string;
      description?: string;
      icon?: string;
      color?: string;
      actions?: Array<{
        id?: string;
        type: string;
        target: string;
        params?: Record<string, unknown>;
        label?: string;
        description?: string;
        targetId?: string;
        timeConstraint?: { durationDays?: number; expiresAt?: Date };
      }>;
      inheritance?: string[];
      tags?: string[];
    },
    _actor?: string,
  ): Promise<RoleBundleLean> {
    const actions = (payload.actions ?? []).map((a) => ({
      ...a,
      id: a.id?.trim() || randomUUID(),
    }));
    const doc = new this.roleBundleModel({
      name: payload.name,
      description: payload.description ?? '',
      icon: payload.icon ?? 'UserOutlined',
      color: payload.color ?? '#1890ff',
      actions,
      inheritance: payload.inheritance ?? [],
      tags: payload.tags ?? [],
      usedByPolicies: 0,
    });
    await doc.save();
    const obj = doc.toObject() as unknown as RoleBundleLean;
    obj.id = String(obj._id);
    return obj;
  }

  async findAll(): Promise<RoleBundleLean[]> {
    const list = await this.roleBundleModel.find().sort({ name: 1 }).lean().exec();
    return list.map((doc) => ({
      ...doc,
      id: String(doc._id),
    }));
  }

  async findOne(id: string): Promise<RoleBundleLean | null> {
    const doc = await this.roleBundleModel.findById(id).lean().exec();
    if (!doc) return null;
    return { ...doc, id: String(doc._id) };
  }

  async update(
    id: string,
    payload: Partial<{
      name: string;
      description: string;
      icon: string;
      color: string;
      actions: Array<{
        id?: string;
        type: string;
        target: string;
        params?: Record<string, unknown>;
        targetId?: string;
        timeConstraint?: { durationDays?: number; expiresAt?: Date };
      }>;
      inheritance: string[];
      tags: string[];
    }>,
    actor?: string,
  ): Promise<RoleBundleLean> {
    const setPayload = { ...payload };
    if (setPayload.actions !== undefined) {
      setPayload.actions = setPayload.actions.map((a) => ({
        ...a,
        id: a.id?.trim() || randomUUID(),
      }));
    }
    const doc = await this.roleBundleModel
      .findByIdAndUpdate(id, { $set: setPayload }, { new: true })
      .lean()
      .exec();
    if (!doc) throw new NotFoundException('Role bundle not found');
    // What the bundle grants changed: the policies using it need a second policy-admin again
    if (payload.actions !== undefined || payload.inheritance !== undefined) {
      await this.sendPoliciesBackToReview(id, actor);
    }
    return { ...doc, id: String(doc._id) };
  }

  /**
   * After a change of what bundle `id` grants (its actions or inheritance), every policy that
   * uses it, directly or through a bundle that inherits it, goes back to DRAFT with the editor as
   * lastEditedBy (an unknown editor as `unknown`), as PolicyService.update does for a change of
   * the policy's own grants: `activate` then needs a second policy-admin. A DISABLED policy goes
   * to DRAFT too, so a toggle cannot bring the unreviewed change live. Audited as policy.updated
   * per policy whose status changed.
   */
  private async sendPoliciesBackToReview(id: string, actor?: string): Promise<void> {
    const bundleIds = await this.bundlesResolvingTo(id);
    const using = await this.policyModel
      .find({ roleBundleId: { $in: bundleIds } })
      .select('_id status')
      .lean()
      .exec();
    if (using.length === 0) return;
    const lastEditedBy = actor || 'unknown';
    await this.policyModel
      .updateMany(
        { _id: { $in: using.map((p) => p._id) } },
        { $set: { status: PolicyStatus.DRAFT, lastEditedBy, lastEditedAt: new Date() } },
      )
      .exec();
    for (const policy of using) {
      if (policy.status === PolicyStatus.DRAFT) continue;
      const policyId = String(policy._id);
      this.eventEmitter.emit<PolicyUpdatedPayload>(
        DomainEventType.POLICY_UPDATED,
        policyId,
        { policyId, changedFields: ['status'], previousStatus: policy.status },
        { actor: lastEditedBy },
      );
    }
  }

  /**
   * The bundle and every bundle whose resolved actions include its own: those that inherit it,
   * directly or through others, as deep as resolveWithInheritance follows.
   */
  private async bundlesResolvingTo(id: string): Promise<string[]> {
    const ids = new Set([id]);
    let level = [id];
    for (let depth = 0; depth < MAX_INHERITANCE_DEPTH && level.length > 0; depth++) {
      const inheritors = await this.roleBundleModel
        .find({ inheritance: { $in: level } })
        .select('_id')
        .lean()
        .exec();
      level = inheritors.map((b) => String(b._id)).filter((b) => !ids.has(b));
      level.forEach((b) => ids.add(b));
    }
    return [...ids];
  }

  async delete(id: string, _actor?: string): Promise<void> {
    const existing = await this.roleBundleModel.findById(id).lean().exec();
    if (!existing) throw new NotFoundException('Role bundle not found');

    const inUse = await this.policyModel.countDocuments({ roleBundleId: id }).exec();
    if (inUse > 0) {
      throw new BadRequestException(
        `Cannot delete role bundle: it is in use by ${inUse} policy/policies. Update or remove those policies first.`,
      );
    }
    // An inheriting bundle would silently lose these actions at the next evaluation
    const inheritedBy = await this.roleBundleModel.countDocuments({ inheritance: id }).exec();
    if (inheritedBy > 0) {
      throw new BadRequestException(
        `Cannot delete role bundle: it is inherited by ${inheritedBy} role bundle(s). Remove it from their inheritance first.`,
      );
    }

    await this.roleBundleModel.findByIdAndDelete(id).exec();
  }

  /**
   * Resolve bundle actions with parent inheritance. Tenant-scoped.
   * Max depth 5 to prevent infinite loops. Deduplicates by type+target+params.
   */
  async resolveWithInheritance(
    id: string,
    tenantId?: string,
    maxDepth = MAX_INHERITANCE_DEPTH,
  ): Promise<RoleBundleAction[]> {
    const resolvedTenantId =
      tenantId ??
      (() => {
        try {
          return getCurrentTenantId();
        } catch {
          return undefined;
        }
      })();

    const visited = new Set<string>();
    const collected: RoleBundleAction[] = [];

    const collect = async (bundleId: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;
      if (visited.has(bundleId)) return;
      visited.add(bundleId);

      const query: Record<string, unknown> = { _id: bundleId };
      if (resolvedTenantId) {
        query.tenantId = resolvedTenantId;
      }
      const doc = await this.roleBundleModel.findOne(query).lean().exec();
      if (!doc) return;

      const bundle = doc as RoleBundle & { _id: unknown };
      const actions = bundle.actions ?? [];
      const inheritance = bundle.inheritance ?? [];

      for (const action of actions) {
        collected.push(action);
      }

      for (const parentId of inheritance) {
        await collect(parentId, depth + 1);
      }
    };

    await collect(id, 0);

    return this.deduplicateActions(collected);
  }

  private deduplicateActions(actions: RoleBundleAction[]): RoleBundleAction[] {
    const seen = new Set<string>();
    return actions.filter((a) => {
      const key = `${a.type}:${a.target}:${JSON.stringify(a.params ?? {})}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
