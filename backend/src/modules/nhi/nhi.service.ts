/**
 * NHI Service — lifecycle of non-human (agent) identities.
 *
 * Core invariants enforced here:
 *   1. Each NHI has an active human owner. An owner who leaves makes the agent ownerless
 *      (NhiOwnershipService): no new credential until it is re-owned or revoked.
 *   2. expiresAt is clamped to MAX_AGENT_LIFETIME_DAYS from createdAt.
 *   3. Delegation is attenuating: child.scope ⊆ parent.scope and
 *      child.expiresAt ≤ parent.expiresAt.
 *   4. Revocation is terminal and cascades to descendants, also below a revoked or expired one, on
 *      every call (a retry completes a cascade that failed part way through); its dry run walks
 *      the same cascade. A delegate whose parent is revoked while the child is stored revokes it.
 *   5. killSwitchEngaged is sticky (cannot be unset).
 *   6. Every read marks the tenant's agents past their expiresAt `expired` first.
 *
 * Revocation, creation, and kill-switch events emit domain events so the
 * Shared Signals (SSF) fan-out and audit log can react without coupling.
 */
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  AgentIdentity,
  AgentIdentityDocument,
  AgentKind,
  AgentRiskTier,
  AgentStatus,
} from './schemas/agent-identity.schema';
import {
  CreateAgentIdentityDto,
  DelegateAgentIdentityDto,
  MAX_AGENT_LIFETIME_DAYS,
} from './dtos/agent-identity.dto';
import { Identity, IdentityDocument } from '../identity/schemas/identity.schema';
import { AuditService } from '../audit/audit.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';

const MAX_LIFETIME_MS = MAX_AGENT_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

export interface RevokeOptions {
  reason: string;
  actor: string;
  killSwitch?: boolean;
}

/** An agent a revoke or kill switch reaches, as the dry run lists it. */
export type CascadeAgent = Pick<
  AgentIdentity,
  'agentId' | 'displayName' | 'kind' | 'owner' | 'parentAgentId' | 'status' | 'expiresAt'
>;
const CASCADE_FIELDS = '-_id agentId displayName kind owner parentAgentId status expiresAt';

/** What POST /nhi/:agentId/revoke or /kill would do (?dryRun=true); nothing is changed. */
export interface EndAgentPreview {
  dryRun: true;
  agentId: string;
  killSwitch: boolean;
  /**
   * False when the call would change nothing: the agent is revoked (or its switch engaged) and no
   * agent delegated from it, at any depth, is still active.
   */
  changes: boolean;
  /** The active delegated agents it would revoke too, depth first; empty when `changes` is false. */
  reached: CascadeAgent[];
}

/** Revocation is terminal: on a revoked agent only a kill switch not yet engaged changes it. */
function endChanges(doc: AgentIdentity, killSwitch: boolean): boolean {
  return doc.status !== 'revoked' || (killSwitch && !doc.killSwitchEngaged);
}

/** Compute risk tier from kind + scope. Deliberately simple — real engine is deferred. */
export function computeRiskTier(kind: AgentKind, scope: string[]): AgentRiskTier {
  const hasAdminWildcard = scope.some((s) => /:(?:\*|admin)$/i.test(s) || /^admin:/i.test(s));
  if (hasAdminWildcard || scope.length > 10) return 'critical';
  if (scope.length > 5 || kind === 'service-account') return 'high';
  if (scope.length > 2 || kind === 'workload') return 'medium';
  return 'low';
}

/** True when `child` is a subset of `parent` (treating scope entries as literals). */
export function isScopeSubset(parent: string[], child: string[]): boolean {
  const parentSet = new Set(parent);
  return child.every((s) => parentSet.has(s));
}

@Injectable()
export class NhiService {
  private readonly logger = new Logger(NhiService.name);

  constructor(
    @InjectModel(AgentIdentity.name)
    private readonly agentModel: Model<AgentIdentityDocument>,
    @InjectModel(Identity.name)
    private readonly identityModel: Model<IdentityDocument>,
    private readonly auditService: AuditService,
    private readonly events: DomainEventEmitterService,
  ) {}

  // ── Create / Delegate ──────────────────────────────────────────────

  /** `parentAgentId` is set by delegate(), in the same write that creates the agent. */
  async create(
    tenantId: string,
    dto: CreateAgentIdentityDto,
    actor: string,
    parentAgentId?: string,
  ): Promise<AgentIdentityDocument> {
    await this.assertOwnerActive(tenantId, dto.ownerIdentityId);
    const expiresAt = this.clampExpiry(new Date(dto.expiresAt), new Date());

    const existing = await this.agentModel.exists({ tenantId, agentId: dto.agentId });
    if (existing) throw new BadRequestException(`Agent '${dto.agentId}' already exists`);

    const doc = await this.agentModel.create({
      tenantId,
      agentId: dto.agentId,
      displayName: dto.displayName,
      kind: dto.kind,
      owner: {
        identityId: dto.ownerIdentityId,
        email: await this.ownerEmail(tenantId, dto.ownerIdentityId),
      },
      scope: dto.scope,
      ...(parentAgentId ? { parentAgentId } : {}),
      expiresAt,
      status: 'active',
      killSwitchEngaged: false,
      riskTier: computeRiskTier(dto.kind, dto.scope),
      createdBy: actor,
      metadata: dto.metadata ?? {},
    });

    await this.auditEvent(tenantId, actor, doc, 'AGENT_IDENTITY_CREATED', 'info');
    this.events.emit(
      DomainEventType.NHI_CREATED,
      doc.agentId,
      {
        agentId: doc.agentId,
        kind: doc.kind,
        ownerIdentityId: doc.owner.identityId,
        riskTier: doc.riskTier,
      },
      { tenantId, actor },
    );
    return doc;
  }

  async delegate(
    tenantId: string,
    parentAgentId: string,
    dto: DelegateAgentIdentityDto,
    actor: string,
  ): Promise<AgentIdentityDocument> {
    const parent = await this.mustGet(tenantId, parentAgentId);
    if (parent.status !== 'active') {
      throw new BadRequestException(`Parent agent '${parentAgentId}' is not active`);
    }

    if (!isScopeSubset(parent.scope, dto.scope)) {
      throw new BadRequestException('Child scope must be a subset of parent scope');
    }

    const childExpiry = new Date(dto.expiresAt);
    if (childExpiry.getTime() > parent.expiresAt.getTime()) {
      throw new BadRequestException('Child expiresAt must not exceed parent expiresAt');
    }

    // One write: a child stored without its parent would be out of the parent's cascade
    const child = await this.create(tenantId, dto, actor, parent.agentId);
    await this.endIfParentRevoked(tenantId, parent.agentId, child, actor);

    this.events.emit(
      DomainEventType.NHI_DELEGATED,
      child.agentId,
      { parentAgentId: parent.agentId, childAgentId: child.agentId },
      { tenantId, actor },
    );
    return child;
  }

  /**
   * A revoke or kill switch of the parent that landed between delegate's check and the child's
   * write walked its cascade before the child existed. The child is then ended as that cascade
   * would have ended it (killed when the parent's switch is engaged) and the delegate refused.
   */
  private async endIfParentRevoked(
    tenantId: string,
    parentAgentId: string,
    child: AgentIdentityDocument,
    actor: string,
  ): Promise<void> {
    const parent = await this.agentModel
      .findOne({ tenantId, agentId: parentAgentId })
      .select('status killSwitchEngaged')
      .lean()
      .exec();
    if (parent?.status !== 'revoked') return;
    await this.endOne(tenantId, child.agentId, {
      reason: `cascade: parent '${parentAgentId}' was revoked while this agent was delegated`,
      actor,
      killSwitch: parent.killSwitchEngaged,
    });
    throw new ConflictException(
      `Parent agent '${parentAgentId}' was revoked while the delegated agent was created; ` +
        `'${child.agentId}' is revoked too.`,
    );
  }

  // ── Revocation ─────────────────────────────────────────────────────

  /**
   * Revokes the agent (engages its kill switch) and every active agent delegated from it. The
   * cascade runs on every call, also when the agent itself is already revoked: a call that failed
   * part way through (an audit write, a database error) is completed by calling again, and each
   * agent already ended is left as it is.
   */
  async revoke(
    tenantId: string,
    agentId: string,
    opts: RevokeOptions,
  ): Promise<AgentIdentityDocument> {
    const { doc } = await this.endOne(tenantId, agentId, opts);
    await this.walkCascade(tenantId, agentId, (child, depth) =>
      this.endOne(tenantId, child.agentId, {
        ...opts,
        reason: `${'cascade: '.repeat(depth)}${opts.reason}`,
      }),
    );
    return doc;
  }

  /**
   * The dry run of revoke(): whether the agent itself would change and the delegated agents the
   * cascade would reach, walked as revoke() walks them. Writes nothing, not even a lazy expiry.
   */
  async previewRevoke(
    tenantId: string,
    agentId: string,
    killSwitch: boolean,
  ): Promise<EndAgentPreview> {
    const doc = await this.agentModel.findOne({ tenantId, agentId }).lean().exec();
    if (!doc) throw new NotFoundException(`Agent '${agentId}' not found`);
    const reached: CascadeAgent[] = [];
    await this.walkCascade(tenantId, agentId, async (child) => {
      reached.push(child);
    });
    const changes = endChanges(doc, killSwitch) || reached.length > 0;
    return { dryRun: true, agentId, killSwitch, changes, reached };
  }

  /** Revokes one agent (and engages its kill switch), audits and signals it; no cascade. */
  private async endOne(
    tenantId: string,
    agentId: string,
    opts: RevokeOptions,
  ): Promise<{ doc: AgentIdentityDocument; changed: boolean }> {
    const doc = await this.mustGet(tenantId, agentId);
    // The first revocation's time, actor and reason stay when a kill switch follows it.
    if (!endChanges(doc, !!opts.killSwitch)) return { doc, changed: false };

    if (doc.status !== 'revoked') {
      doc.status = 'revoked';
      doc.revokedAt = new Date();
      doc.revokedBy = opts.actor;
      doc.revocationReason = opts.reason;
    }
    if (opts.killSwitch) doc.killSwitchEngaged = true;
    await doc.save();

    const action = opts.killSwitch ? 'AGENT_IDENTITY_KILL_SWITCH' : 'AGENT_IDENTITY_REVOKED';
    const severity = opts.killSwitch ? 'critical' : 'warning';
    await this.auditEvent(tenantId, opts.actor, doc, action, severity);

    this.events.emit(
      opts.killSwitch ? DomainEventType.NHI_KILL_SWITCH_ENGAGED : DomainEventType.NHI_REVOKED,
      doc.agentId,
      {
        agentId: doc.agentId,
        reason: opts.reason,
        killSwitch: !!opts.killSwitch,
      },
      { tenantId, actor: opts.actor },
    );
    return { doc, changed: true };
  }

  /**
   * The cascade of a revoke or kill switch of `agentId`: each delegated agent stored as active,
   * then its own delegates, depth first. The walk goes on below a revoked or expired agent, whose
   * delegates can still be active (a cascade that failed part way through), but `visit` runs only
   * for active ones, before their delegates are read. revoke() revokes there and previewRevoke()
   * only collects, so the dry run lists the agents the real call reaches. `seen` stops a parent
   * chain that loops back.
   */
  private async walkCascade(
    tenantId: string,
    agentId: string,
    visit: (child: CascadeAgent, depth: number) => Promise<unknown>,
    seen: Set<string> = new Set([agentId]),
    depth = 1,
  ): Promise<void> {
    const children = await this.agentModel
      .find({ tenantId, parentAgentId: agentId })
      .select(CASCADE_FIELDS)
      .lean<CascadeAgent[]>()
      .exec();
    for (const child of children) {
      if (seen.has(child.agentId)) continue;
      seen.add(child.agentId);
      if (child.status === 'active') await visit(child, depth);
      await this.walkCascade(tenantId, child.agentId, visit, seen, depth + 1);
    }
  }

  // ── Read ───────────────────────────────────────────────────────────

  async list(
    tenantId: string,
    filter: {
      ownerIdentityId?: string;
      kind?: AgentKind;
      status?: AgentStatus;
      riskTier?: AgentRiskTier;
      ownerless?: boolean;
    },
    page: number,
    limit: number,
  ): Promise<{ data: AgentIdentityDocument[]; total: number }> {
    await this.expireDue(tenantId);
    const q: Record<string, unknown> = { tenantId };
    if (filter.ownerIdentityId) q['owner.identityId'] = filter.ownerIdentityId;
    if (filter.kind) q.kind = filter.kind;
    if (filter.status) q.status = filter.status;
    if (filter.riskTier) q.riskTier = filter.riskTier;
    if (filter.ownerless !== undefined) q.ownerlessSince = { $exists: filter.ownerless };

    const [data, total] = await Promise.all([
      this.agentModel
        .find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.agentModel.countDocuments(q).exec(),
    ]);
    return { data: data as AgentIdentityDocument[], total };
  }

  async get(tenantId: string, agentId: string): Promise<AgentIdentityDocument | null> {
    await this.expireDue(tenantId, agentId);
    return this.agentModel.findOne({ tenantId, agentId }).exec();
  }

  async mustGet(tenantId: string, agentId: string): Promise<AgentIdentityDocument> {
    const doc = await this.get(tenantId, agentId);
    if (!doc) throw new NotFoundException(`Agent '${agentId}' not found`);
    return doc;
  }

  /**
   * Marks the tenant's agents past their expiresAt `expired` (only `agentId` when given), so a
   * read answers the status and `?status=` filters on it, without a cron. Only agents still
   * stored as active change: a revoke that lands first is never overwritten.
   */
  private async expireDue(tenantId: string, agentId?: string): Promise<void> {
    await this.agentModel
      .updateMany(
        {
          tenantId,
          ...(agentId ? { agentId } : {}),
          status: 'active',
          expiresAt: { $lte: new Date() },
        },
        { $set: { status: 'expired' } },
      )
      .exec();
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /** 400 unless `identityId` is a live, ACTIVE identity of the tenant (create, delegate, re-own). */
  async assertOwnerActive(tenantId: string, identityId: string): Promise<void> {
    const owner = await this.identityModel
      .findOne({ _id: identityId, tenantId })
      .select('profile.status deletedAt')
      .lean()
      .exec();
    if (!owner) throw new BadRequestException(`Owner identity '${identityId}' not found`);
    if (owner.deletedAt) throw new BadRequestException('Owner identity is deleted');
    if (owner.profile?.status && owner.profile.status !== 'ACTIVE') {
      throw new BadRequestException(`Owner identity must be active (was ${owner.profile.status})`);
    }
  }

  /** The owner's email as the agent stores it (denormalised for list views). */
  async ownerEmail(tenantId: string, identityId: string): Promise<string> {
    const owner = await this.identityModel
      .findOne({ _id: identityId, tenantId })
      .select('profile.email')
      .lean()
      .exec();
    return owner?.profile?.email ?? 'unknown';
  }

  private clampExpiry(requested: Date, now: Date): Date {
    const max = new Date(now.getTime() + MAX_LIFETIME_MS);
    return requested.getTime() > max.getTime() ? max : requested;
  }

  private async auditEvent(
    tenantId: string,
    actor: string,
    doc: AgentIdentityDocument,
    action: string,
    severity: 'info' | 'warning' | 'critical',
  ): Promise<void> {
    await this.auditService.log({
      action: action as never,
      severity,
      actor,
      resourceType: 'agent-identity',
      resourceId: doc.agentId,
      resourceName: doc.displayName,
      description: `${action} ${doc.agentId} (${doc.kind})`,
      payload: {
        metadata: {
          ownerIdentityId: doc.owner.identityId,
          riskTier: doc.riskTier,
          killSwitchEngaged: doc.killSwitchEngaged,
        },
      },
      tenantId,
    });
  }
}
