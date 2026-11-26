import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  EntitlementCatalog,
  EntitlementCatalogDocument,
  EntitlementOrigin,
  EntitlementGovernanceLevel,
} from './schemas/entitlement-catalog.schema';
import { Entitlement } from '@shared/interfaces/provisioning.interface';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DiscoveryCompletedPayload } from '@infrastructure/events/event-payloads';
import { classifyByRid, classifyByTemplateId } from '../policy/pam-classification';
import type { IEntitlementCatalogPort } from '@shared/interfaces/entitlement-catalog.port';
import {
  loadCatalogTargetLookup,
  type CatalogTargetLookup,
  type PolicyTarget,
} from './catalog-target-lookup';

/**
 * Catalog of entitlements (groups, licenses) per system. Upserted from discovery or policy references.
 */
@Injectable()
export class EntitlementCatalogService implements IEntitlementCatalogPort {
  private readonly logger = new Logger(EntitlementCatalogService.name);

  constructor(
    @InjectModel(EntitlementCatalog.name)
    private readonly catalogModel: Model<EntitlementCatalogDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * Upsert an entitlement. Use when discovering (EXTERNAL) or when a policy references a group (POLICY).
   */
  async upsert(
    system: string,
    payload: {
      nativeId?: string;
      name: string;
      type: 'Group' | 'License' | 'DirectoryRole';
      origin?: EntitlementOrigin;
      governanceLevel?: EntitlementGovernanceLevel;
      owner?: string;
      riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    },
  ): Promise<EntitlementCatalogDocument> {
    const origin = payload.origin ?? 'EXTERNAL';
    const governanceLevel = payload.governanceLevel ?? (origin === 'POLICY' ? 'STRICT' : 'OPEN');

    const key = payload.nativeId
      ? { system, nativeId: payload.nativeId }
      : { system, name: payload.name.trim() };

    const setFields: Record<string, unknown> = {
      name: payload.name.trim(),
      type: payload.type,
      origin,
      governanceLevel,
      ...(payload.nativeId && { nativeId: payload.nativeId }),
    };
    if (payload.owner !== undefined) setFields.owner = payload.owner;
    if (payload.riskLevel !== undefined) setFields.riskLevel = payload.riskLevel;

    const doc = await this.catalogModel.findOneAndUpdate(
      key,
      { $set: setFields },
      { new: true, upsert: true },
    );
    return doc;
  }

  /**
   * Get origin for a group/license. Used by group sync to decide: only remove if origin === 'POLICY'.
   * Tries nativeId first, then name (case-insensitive).
   */
  async getOrigin(
    system: string,
    nativeId?: string,
    name?: string,
  ): Promise<EntitlementOrigin | null> {
    if (nativeId) {
      const byId = await this.catalogModel.findOne({ system, nativeId }).select('origin').lean();
      if (byId) return byId.origin as EntitlementOrigin;
    }
    if (name && name.trim()) {
      const normalized = name.trim();
      const byName = await this.catalogModel
        .findOne({ system, name: normalized })
        .select('origin')
        .lean();
      if (byName) return byName.origin as EntitlementOrigin;
      const byNameCaseInsensitive = await this.catalogModel
        .findOne({
          system,
          name: { $regex: `^${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
        })
        .select('origin')
        .lean();
      if (byNameCaseInsensitive) return byNameCaseInsensitive.origin as EntitlementOrigin;
    }
    return null;
  }

  /**
   * Return true if this entitlement is policy-managed (strict revert). False or null = do not revert.
   */
  async isPolicyManaged(system: string, nativeId?: string, name?: string): Promise<boolean> {
    const origin = await this.getOrigin(system, nativeId, name);
    return origin === 'POLICY';
  }

  /**
   * Find catalog entry by system and nativeId.
   */
  async findBySystemAndNativeId(
    system: string,
    nativeId: string,
  ): Promise<EntitlementCatalogDocument | null> {
    return this.catalogModel.findOne({ system, nativeId }).exec();
  }

  /**
   * PAM: Find catalog entry for admin redirect. Tries nativeId first, then name (case-insensitive).
   * Returns adminTier and requiresAdminAccount when entitlement requires linked admin identity.
   */
  async findForAdminRedirect(
    tenantId: string,
    system: string,
    targetId: string,
  ): Promise<{ adminTier: string; requiresAdminAccount: boolean } | null> {
    const trimmed = targetId?.trim();
    if (!trimmed) return null;

    const filter: Record<string, unknown> = { tenantId, system };

    let entry: { adminTier?: string; requiresAdminAccount?: boolean } | null = null;

    if (EntitlementCatalogService.UUID_REGEX.test(trimmed)) {
      entry = await this.catalogModel
        .findOne({ ...filter, nativeId: trimmed })
        .select('adminTier requiresAdminAccount')
        .lean()
        .exec();
    }

    if (!entry) {
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      entry = await this.catalogModel
        .findOne({ ...filter, name: { $regex: `^${escaped}$`, $options: 'i' } })
        .select('adminTier requiresAdminAccount')
        .lean()
        .exec();
    }

    if (!entry || !entry.requiresAdminAccount || !entry.adminTier) return null;
    return {
      adminTier: entry.adminTier,
      requiresAdminAccount: entry.requiresAdminAccount === true,
    };
  }

  /**
   * Get owner (email or identity ID) for an entitlement. Used by access review reviewer chain.
   */
  async getOwner(system: string, nativeId: string): Promise<string | null> {
    const entry = await this.catalogModel
      .findOne({ system, nativeId })
      .select('owner')
      .lean()
      .exec();
    return entry?.owner ?? null;
  }

  /**
   * Batch lookup: return map of (system:nativeId) -> { owner, riskLevel }. Avoids N+1 in activate().
   */
  async getCatalogEntriesBatch(
    pairs: Array<{ system: string; nativeId: string }>,
  ): Promise<Map<string, { owner?: string; riskLevel: string }>> {
    if (pairs.length === 0) return new Map();
    const bySystem = new Map<string, string[]>();
    for (const { system, nativeId } of pairs) {
      if (!nativeId) continue;
      const list = bySystem.get(system) ?? [];
      list.push(nativeId);
      bySystem.set(system, list);
    }
    const results = new Map<string, { owner?: string; riskLevel: string }>();
    for (const [system, nativeIds] of bySystem) {
      const docs = await this.catalogModel
        .find({ system, nativeId: { $in: nativeIds } })
        .select('nativeId owner riskLevel')
        .lean()
        .exec();
      for (const doc of docs) {
        if (doc.nativeId) {
          results.set(`${system}:${doc.nativeId}`, {
            owner: doc.owner,
            riskLevel: doc.riskLevel ?? 'MEDIUM',
          });
        }
      }
    }
    return results;
  }

  /**
   * Return true if this entitlement has the PROTECTED governance tag.
   */
  async isProtected(system: string, nativeId: string): Promise<boolean> {
    const entry = await this.findBySystemAndNativeId(system, nativeId);
    return entry?.governanceTags?.includes('PROTECTED') ?? false;
  }

  /**
   * Batch lookup: return Set of nativeIds that have the PROTECTED tag. Avoids N+1 queries.
   */
  async getProtectedNativeIds(system: string, nativeIds: string[]): Promise<Set<string>> {
    if (nativeIds.length === 0) return new Set();
    const docs = await this.catalogModel
      .find({ system, nativeId: { $in: nativeIds }, governanceTags: 'PROTECTED' })
      .select('nativeId')
      .lean()
      .exec();
    const ids = docs
      .map((d) => (d as { nativeId?: string }).nativeId)
      .filter((id): id is string => typeof id === 'string');
    return new Set(ids);
  }

  /**
   * List catalog entries with the given governance tag.
   */
  async getByTag(tenantId: string, tag: string): Promise<EntitlementCatalogDocument[]> {
    return this.catalogModel.find({ tenantId, governanceTags: tag }).sort({ name: 1 }).exec();
  }

  /**
   * Update governance tags for a catalog entry.
   */
  async setTags(catalogId: string, tags: string[]): Promise<EntitlementCatalogDocument | null> {
    const doc = await this.catalogModel
      .findByIdAndUpdate(catalogId, { $set: { governanceTags: tags } }, { new: true })
      .exec();
    return doc ?? null;
  }

  /**
   * List catalog entries by system (and optionally by origin and type).
   */
  async list(
    system: string,
    options?: { origin?: EntitlementOrigin; type?: 'Group' | 'License' | 'DirectoryRole' },
  ): Promise<EntitlementCatalogDocument[]> {
    const filter: Record<string, unknown> = { system };
    if (options?.origin) filter.origin = options.origin;
    if (options?.type) filter.type = options.type;
    return this.catalogModel.find(filter).sort({ name: 1 }).exec();
  }

  /**
   * List requestable catalog entries for the Access Request Portal.
   * Paginated with optional category, search, and system filters.
   */
  async listRequestable(
    tenantId: string,
    filters: {
      category?: string;
      search?: string;
      system?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{ data: EntitlementCatalogDocument[]; total: number }> {
    const filter: Record<string, unknown> = { tenantId, requestable: true };
    if (filters.category?.trim()) filter.category = filters.category.trim();
    if (filters.system?.trim()) filter.system = filters.system.trim();
    if (filters.search?.trim()) {
      const search = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { userDescription: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
      ];
    }
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20));
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.catalogModel.find(filter).sort({ category: 1, name: 1 }).skip(skip).limit(limit).exec(),
      this.catalogModel.countDocuments(filter),
    ]);
    return { data, total };
  }

  private static readonly BULK_CHUNK_SIZE = 5_000;
  private static readonly BULK_CHUNK_THRESHOLD = 10_000;

  /** Well-known groups that should be tagged PROTECTED during discovery (backward compatibility). */
  private static readonly WELL_KNOWN_PROTECTED_NAMES = [
    'All Users',
    'All Company',
    'Everyone',
    'All Employees',
  ].map((n) => n.toLowerCase());

  /**
   * After discovery: absorb discovered items as EXTERNAL (unless already POLICY).
   * Merges with policy-registered entries: if we have a doc by name with POLICY, update it with nativeId.
   * Removes EXTERNAL entries whose nativeId is no longer in Entra (groups/licenses deleted there).
   * Uses bulkWrite for O(1) DB ops instead of O(N). Then emits discovery.completed (the access
   * graph's event sync names the system's entitlements from the catalog).
   */
  async absorbDiscovered(system: string, entitlements: Entitlement[]): Promise<void> {
    const discoveredNativeIds = new Set(
      entitlements.filter((e) => e.nativeId).map((e) => e.nativeId!),
    );

    const tenantId = getCurrentTenantId();

    const nativeIds = entitlements.filter((e) => e.nativeId).map((e) => e.nativeId!);
    const names = entitlements.map((e) => e.name.trim()).filter(Boolean);

    const orConditions: Array<Record<string, unknown>> = [];
    if (nativeIds.length > 0) orConditions.push({ nativeId: { $in: nativeIds } });
    if (names.length > 0) orConditions.push({ name: { $in: names } });
    if (orConditions.length === 0) {
      this.logger.log(`[CATALOG] No entitlements to absorb for ${system}`);
      return;
    }

    const existing = await this.catalogModel.find({ system, $or: orConditions }).lean().exec();

    const byNativeId = new Map<string, (typeof existing)[0]>();
    const byName = new Map<string, (typeof existing)[0]>();
    for (const doc of existing) {
      if (doc.nativeId) byNativeId.set(doc.nativeId, doc);
      if (doc.name) byName.set(doc.name, doc);
    }

    const ops: Array<{
      updateOne: {
        filter: Record<string, unknown>;
        update: { $set: Record<string, unknown> };
        upsert?: boolean;
      };
    }> = [];

    for (const e of entitlements) {
      const existingDoc = (e.nativeId ? byNativeId.get(e.nativeId) : null) ?? byName.get(e.name);
      const origin: EntitlementOrigin = existingDoc?.origin === 'POLICY' ? 'POLICY' : 'EXTERNAL';
      const governanceLevel: EntitlementGovernanceLevel = origin === 'POLICY' ? 'STRICT' : 'OPEN';

      const isWellKnownProtected = EntitlementCatalogService.WELL_KNOWN_PROTECTED_NAMES.includes(
        e.name.trim().toLowerCase(),
      );
      const existingTags =
        (existingDoc as { governanceTags?: string[] } | undefined)?.governanceTags ?? [];
      const governanceTags = isWellKnownProtected
        ? [...new Set([...existingTags, 'PROTECTED'])]
        : existingTags;

      // PAM classification: stamp admin tier from metadata at catalog ingestion time.
      // This keeps discovery dumb (Hands) and classification in the Brain layer.
      let { adminTier, requiresAdminAccount, riskLevel } = e;
      const metadata = e.metadata as Record<string, unknown> | undefined;
      if (metadata) {
        const templateId = metadata.templateId as string | undefined;
        const rid = metadata.rid as string | undefined;
        if (templateId) {
          const classification = classifyByTemplateId(templateId);
          if (classification) {
            adminTier = classification.tier;
            requiresAdminAccount = true;
            riskLevel = classification.riskLevel;
          }
        } else if (rid) {
          const classification = classifyByRid(rid);
          if (classification) {
            adminTier = classification.tier;
            requiresAdminAccount = true;
            riskLevel = classification.riskLevel;
          }
        }
      }

      const updateFields: Record<string, unknown> = {
        name: e.name.trim(),
        type: e.type,
        origin,
        governanceLevel,
        tenantId,
        governanceTags,
        ...(e.nativeId && { nativeId: e.nativeId }),
      };
      if (adminTier !== undefined) updateFields.adminTier = adminTier;
      if (requiresAdminAccount !== undefined)
        updateFields.requiresAdminAccount = requiresAdminAccount;
      if (riskLevel !== undefined) updateFields.riskLevel = riskLevel;
      // A license's units as the target reports them now (the license forecast starts from them)
      if (e.type === 'License' && e.licenseUnits) {
        updateFields.licenseUnits = { ...e.licenseUnits, observedAt: new Date() };
      }

      if (existingDoc) {
        ops.push({
          updateOne: {
            filter: { _id: existingDoc._id, tenantId },
            update: { $set: updateFields },
          },
        });
      } else {
        const filter: Record<string, unknown> = { tenantId, system };
        if (e.nativeId) {
          filter.nativeId = e.nativeId;
        } else {
          filter.name = e.name.trim();
        }
        ops.push({
          updateOne: {
            filter,
            update: { $set: { ...updateFields, system } },
            upsert: true,
          },
        });
      }
    }

    const chunks =
      ops.length > EntitlementCatalogService.BULK_CHUNK_THRESHOLD
        ? this.chunk(ops, EntitlementCatalogService.BULK_CHUNK_SIZE)
        : [ops];

    for (const chunk of chunks) {
      if (chunk.length > 0) {
        await this.catalogModel.bulkWrite(chunk, { ordered: false });
      }
    }

    let removed = 0;
    if (discoveredNativeIds.size > 0) {
      const result = await this.catalogModel.deleteMany({
        system,
        origin: 'EXTERNAL',
        nativeId: { $nin: Array.from(discoveredNativeIds), $exists: true, $ne: null },
      });
      removed = result.deletedCount ?? 0;
      if (removed > 0) {
        this.logger.log(`[CATALOG] Removed ${removed} stale EXTERNAL entries for ${system}`);
      }
    }
    this.logger.log(`[CATALOG] Absorbed ${entitlements.length} entitlements for ${system}`);
    this.eventEmitter.emit<DiscoveryCompletedPayload>(
      DomainEventType.DISCOVERY_COMPLETED,
      system,
      { system, discovered: entitlements.length, removed },
      { tenantId },
    );
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }

  /** UUID v4 pattern: avoid registering GUID-as-name (policy stores nativeId in groupName param). */
  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  /**
   * Register a group as POLICY when a policy references it (assign_group for this system).
   * If groupName is a GUID (policy stores nativeId), resolve to display name from catalog to avoid corruption.
   */
  async registerPolicyGroup(system: string, groupName: string): Promise<void> {
    const trimmed = groupName.trim();
    if (!trimmed) return;

    let nameToRegister = trimmed;
    let nativeIdToUse: string | undefined;
    if (EntitlementCatalogService.UUID_REGEX.test(trimmed)) {
      const existing = await this.catalogModel
        .findOne({ system, nativeId: trimmed })
        .select('name nativeId')
        .lean();
      if (existing?.name && !EntitlementCatalogService.UUID_REGEX.test(existing.name)) {
        nameToRegister = existing.name;
        nativeIdToUse = existing.nativeId ?? trimmed;
        this.logger.debug(`[CATALOG] Resolved GUID to name: ${existing.name}`);
      } else {
        return;
      }
    }

    await this.upsert(system, {
      name: nameToRegister,
      type: 'Group',
      origin: 'POLICY',
      governanceLevel: 'STRICT',
      ...(nativeIdToUse && { nativeId: nativeIdToUse }),
    });
  }

  /**
   * The tenant's catalog entries the targets can stand for, by native id or by unique name on
   * the system (catalog-target-lookup.ts): one id form for a rule's, a request's and an SoD
   * policy's way of naming an entitlement.
   */
  loadTargetLookup(tenantId: string, targets: PolicyTarget[]): Promise<CatalogTargetLookup> {
    return loadCatalogTargetLookup(this.catalogModel, tenantId, targets);
  }

  /**
   * Find catalog entry by ID (tenant-scoped). Returns null if not found.
   */
  async findCatalogEntryById(
    tenantId: string,
    id: string,
  ): Promise<EntitlementCatalogDocument | null> {
    const doc = await this.catalogModel.findOne({ _id: id, tenantId }).exec();
    return doc ?? null;
  }

  /**
   * SCIM inbound: Find catalog entry by ID (for system scim-inbound).
   */
  async findById(id: string): Promise<EntitlementCatalogDocument | null> {
    const doc = await this.catalogModel.findById(id).exec();
    if (!doc || doc.system !== 'scim-inbound') return null;
    return doc;
  }

  /**
   * SCIM inbound: Create a SCIM group (entitlement catalog entry).
   * Returns null if a group with the same displayName exists in the tenant (409 conflict), also
   * when another create of that name got there first (the unique index).
   */
  async createScimGroup(payload: {
    name: string;
    externalId?: string;
    scimMembers?: string[];
    /** The type of each member the IdP sent one for (User or Group); the others are users. */
    scimMemberTypes?: Array<{ value: string; type: 'User' | 'Group' }>;
  }): Promise<EntitlementCatalogDocument | null> {
    const existing = await this.catalogModel
      .findOne({
        system: 'scim-inbound',
        name: payload.name.trim(),
        type: 'Group',
      })
      .exec();
    if (existing) return null;

    const metadata: Record<string, unknown> = {
      scimMembers: payload.scimMembers ?? [],
      scimMemberTypes: payload.scimMemberTypes ?? [],
    };
    if (payload.externalId) metadata.externalId = payload.externalId;

    try {
      return await this.catalogModel.create({
        system: 'scim-inbound',
        name: payload.name.trim(),
        type: 'Group',
        origin: 'EXTERNAL',
        governanceLevel: 'OPEN',
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      });
    } catch (err: unknown) {
      // A create of the same name won the race (scim_group_name_unique): 409 as for a lookup hit
      if ((err as { code?: unknown } | null)?.code === 11000) return null;
      throw err;
    }
  }

  /**
   * SCIM inbound: Update a SCIM group. Returns null if not found.
   */
  async updateScimGroup(
    id: string,
    payload: {
      name?: string;
      externalId?: string;
      /** The members; replaces the stored types with scimMemberTypes (none when absent). */
      scimMembers?: string[];
      scimMemberTypes?: Array<{ value: string; type: 'User' | 'Group' }>;
    },
  ): Promise<EntitlementCatalogDocument | null> {
    const doc = await this.catalogModel.findById(id).exec();
    if (!doc || doc.system !== 'scim-inbound') return null;

    const updates: Record<string, unknown> = {};
    if (payload.name !== undefined) updates.name = payload.name.trim();
    if (payload.externalId !== undefined || payload.scimMembers !== undefined) {
      const meta = { ...(doc.metadata ?? {}) };
      if (payload.externalId !== undefined) meta.externalId = payload.externalId;
      if (payload.scimMembers !== undefined) {
        meta.scimMembers = payload.scimMembers;
        meta.scimMemberTypes = payload.scimMemberTypes ?? [];
      }
      updates.metadata = meta;
    }

    const updated = await this.catalogModel
      .findByIdAndUpdate(id, { $set: updates }, { new: true })
      .exec();
    return updated;
  }

  /**
   * SCIM inbound: Delete a SCIM group. Returns true if deleted.
   */
  async deleteScimGroup(id: string): Promise<boolean> {
    const result = await this.catalogModel.deleteOne({
      _id: id,
      system: 'scim-inbound',
      type: 'Group',
    });
    return (result.deletedCount ?? 0) > 0;
  }

  /**
   * SCIM inbound: List SCIM groups with pagination and optional filter.
   */
  async listScimGroups(
    filter: Record<string, unknown> = {},
    skip = 0,
    limit = 100,
  ): Promise<{ data: EntitlementCatalogDocument[]; total: number }> {
    const baseFilter = { system: 'scim-inbound', type: 'Group' };
    const fullFilter = { ...baseFilter, ...filter };

    const [data, total] = await Promise.all([
      this.catalogModel.find(fullFilter).sort({ name: 1 }).skip(skip).limit(limit).exec(),
      this.catalogModel.countDocuments(fullFilter),
    ]);
    return { data, total };
  }
}
