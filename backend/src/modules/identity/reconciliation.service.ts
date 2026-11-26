/**
 * ReconciliationService - The Brain for the Onion Model
 *
 * Computes the Golden Record (profile) from raw sources and admin controls.
 * Data segregation: raw data lives in sources; only this service writes profile.
 *
 * Multi-HR: Primary HR source wins for contract-critical fields; secondary supplements.
 * See docs/MULTI_HR_INGESTION.md. Attribute controls (attribute-controls.ts) replace the merged
 * department and job title while set; hrOwnersOf tells which fields an HR source masters.
 *
 * All rules (HR tags, mastery, critical fields) are loaded from per-tenant
 * ReconciliationConfig in the database. No hardcoded defaults.
 *
 * Trigger points:
 * - When a Connector pushes new data to identity.sources
 * - When an Admin updates identity.controls
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import type {
  IdentityDocument,
  IdentityProfile,
  LinkedAccount,
  IdentityControls,
} from './schemas/identity.schema';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import type { ReconciliationConfigDocument } from './schemas/reconciliation-config.schema';
import { isEmpty, type DroppedFields } from './dropped-fields';
import { CONTROLLED_ATTRIBUTES, controlValue } from './attribute-controls';
import { NOT_A_PROFILE_VALUE, profileValue } from './profile-enum-values';
import { normalizeEmail, sameEmail } from '@shared/utils/email';

/** How a source may write a profile field: replace any value, only fill an empty one, or not. */
type WriteRule = 'overwrite' | 'fill' | null;

/** The merge rules of one identity's sources (ReconciliationService.mergeRules). */
interface MergeRules {
  primary?: LinkedAccount;
  /** Merge order: the primary HR source first. */
  sorted: LinkedAccount[];
  isTarget: (source: LinkedAccount) => boolean;
  carries: (source: LinkedAccount, path: string) => boolean;
  writeRule: (source: LinkedAccount, key: string, path?: string) => WriteRule;
}

/** Profile keys a drop never clears: the schema requires them, and status has a default. */
const NEVER_CLEARED = new Set(['email', 'status', 'firstName', 'lastName']);

/** A custom attribute's path: `customAttributes.<key>`. */
const CUSTOM = 'customAttributes.';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly correlationConfigService: CorrelationConfigService,
    private readonly reconConfigService: ReconciliationConfigService,
  ) {}

  /**
   * Reconcile an identity: compute profile from sources + controls, then save.
   * Step 1: Load tenant reconciliation config.
   * Step 2: Build profile (primary HR for contract-critical; merge for rest).
   * Step 3: Apply controls.
   * Step 4: Apply kill switch.
   * Step 5: Persist profile + metadata.primaryHrSource.
   *
   * The kill switch keeps the status it replaced (metadata.statusUnderKillSwitch), and while that
   * is kept the merge starts from it instead of the stored SUSPENDED: a target source only fills
   * the status, so turning the switch off would otherwise leave a non-HR identity SUSPENDED.
   *
   * `dropped`: the fields a source no longer carries since its previous record. A source that may
   * overwrite such a field (its owner) clears it; any other source's drop changes nothing.
   */
  async reconcile(
    identity: IdentityDocument,
    options?: { fieldMasteryOverrides?: Record<string, string[]>; dropped?: DroppedFields },
    session?: ClientSession,
  ): Promise<IdentityDocument> {
    this.logger.log(`[Reconcile] Starting for identity ${identity._id}`);

    const { reconConfig, priorityMap } = await this.loadMergeConfig(identity.tenantId);
    const sources = identity.sources || [];
    // The status the kill switch replaced, kept while it is on (null: the merge gave none)
    const heldStatus = (identity.metadata as { statusUnderKillSwitch?: string | null } | undefined)
      ?.statusUnderKillSwitch;
    const baseProfile =
      heldStatus === undefined
        ? identity.profile
        : ({
            ...this.profileToPlain(identity.profile),
            status: heldStatus ?? undefined,
          } as unknown as IdentityProfile);
    const mastery = identity.metadata?.mastery || {};
    const masteryOverrides =
      options?.fieldMasteryOverrides ??
      ((identity.metadata as Record<string, unknown> | undefined)?.fieldMasteryOverrides as
        | Record<string, string[]>
        | undefined);

    // Step 2: Merge sources (primary/secondary aware)
    const ownerCleared =
      (identity.metadata as { ownerClearedFields?: string[] } | undefined)?.ownerClearedFields ??
      [];
    const { merged, primaryHrSource, primaryContractExternalId, ownerClearedFields } =
      this.mergeSourcesIntoProfile(
        sources,
        baseProfile,
        mastery,
        masteryOverrides,
        priorityMap,
        reconConfig,
        options?.dropped,
        ownerCleared,
      );

    // Step 3: Apply controls: an attribute control (manualDepartment, manualJobTitle) replaces the
    // merged value at every reconcile until it is removed or expires (attribute-controls.ts)
    const controls: IdentityControls = identity.controls || ({} as IdentityControls);
    for (const attribute of CONTROLLED_ATTRIBUTES) {
      const value = controlValue(controls, attribute);
      if (value === undefined) continue;
      (merged as unknown as Record<string, unknown>)[attribute] = value;
      this.logger.log(`[Reconcile] Override: ${attribute} from its control`);
    }
    if (controls.overrides?.email) {
      merged.email = controls.overrides.email;
    }
    if (typeof merged.email === 'string') {
      merged.email = await this.emailToStore(identity, merged.email, session);
    }

    // Step 4: Admin kill switch
    const loginDisabled = controls.isLoginDisabled === true;
    const statusUnderKillSwitch = merged.status ?? null;
    if (loginDisabled) {
      merged.status = UserStatus.SUSPENDED;
      this.logger.log(`[Reconcile] Override: isLoginDisabled -> status SUSPENDED`);
    }

    // Step 5: Save
    identity.profile = merged as IdentityProfile;
    const metadata = identity.metadata ?? {};
    metadata.version = (metadata.version ?? 0) + 1;
    metadata.primaryHrSource = primaryHrSource;
    metadata.primaryContractExternalId = primaryContractExternalId;
    if (loginDisabled) metadata.statusUnderKillSwitch = statusUnderKillSwitch;
    else delete metadata.statusUnderKillSwitch;
    identity.metadata = metadata;
    // metadata is Mixed (type: Object): Mongoose saves a change inside it only when told so
    identity.markModified('metadata');
    if (ownerClearedFields.join() !== ownerCleared.join()) {
      // set() on the subpath: metadata is Mixed, so a plain assignment would not be saved
      identity.set(
        'metadata.ownerClearedFields',
        ownerClearedFields.length ? ownerClearedFields : undefined,
      );
    }
    await identity.save(session ? { session } : {});

    this.logger.log(
      `[Reconcile] Saved profile for identity ${identity._id}, primaryHr=${primaryHrSource ?? 'none'}`,
    );
    return identity;
  }

  /**
   * The email reconcile stores: trimmed and lower-cased (shared/utils/email.ts). A stored value
   * that is the same address in another case stays while another live identity of the tenant has
   * the lower-cased form: two identities stored before this rule whose emails differ only in case
   * would otherwise collide on the unique email index at every sync. The 2026-11-25 email migration
   * raised such pairs as correlation conflicts; once merged, the survivor is lower-cased here.
   */
  private async emailToStore(
    identity: IdentityDocument,
    email: string,
    session?: ClientSession,
  ): Promise<string> {
    const normalized = normalizeEmail(email);
    const stored = (identity.profile as { email?: unknown } | undefined)?.email;
    if (stored === normalized || !sameEmail(stored, normalized)) return normalized;
    const holder = await this.identityModel
      .exists({
        tenantId: identity.tenantId,
        'profile.email': normalized,
        deletedAt: null,
        _id: { $ne: identity._id },
      })
      .session(session ?? null)
      .exec();
    return holder ? (stored as string) : normalized;
  }

  /**
   * Merge sources: the primary HR source alone writes a contract-critical field (no master
   * applies to it, explicit or configured).
   * A field's masters: its explicit master (metadata.mastery), else its `fieldMasteryOverrides`
   * list, else its config.defaultMastery list. The first listed source with a value is the
   * master: its value overwrites, a target's too, and no other source changes the field. While
   * no master has a value, any other source fills the empty field.
   * A field without master: the primary HR source's value wins; a secondary HR source writes it
   * only while no HR source ahead of it in the merge order has a value; a target only fills.
   * A field the owning source dropped (`dropped`) is cleared first; another source allowed to
   * overwrite it may set it again, a target may not fill it from its (stale) copy. The cleared
   * keys stay blocked for targets across merges (`ownerCleared`, kept in
   * metadata.ownerClearedFields) until a source allowed to overwrite them sets them again.
   * Required keys (NEVER_CLEARED) are never cleared by a drop.
   */
  private mergeSourcesIntoProfile(
    sources: LinkedAccount[],
    existingProfile: IdentityProfile,
    mastery: Record<string, string>,
    fieldMasteryOverrides?: Record<string, string[]>,
    connectorPriorityMap?: Map<string, { priority: number; contractTag?: string }>,
    reconConfig?: ReconciliationConfigDocument | null,
    dropped?: DroppedFields,
    ownerCleared: string[] = [],
  ): {
    merged: IdentityProfile;
    primaryHrSource?: string;
    primaryContractExternalId?: string;
    ownerClearedFields: string[];
  } {
    const targetIdKeys = new Set(reconConfig?.targetIdKeys ?? []);
    const { primary, sorted, isTarget, writeRule } = this.mergeRules(
      sources,
      mastery,
      fieldMasteryOverrides,
      connectorPriorityMap,
      reconConfig,
    );
    const primaryHrSource = primary?.sourceName;
    const primaryContractExternalId = primary?.externalId;

    // A plain base: a target fills only what the profile leaves empty (`existing` below)
    const merged = this.profileToPlain(existingProfile);
    const customAttrs = { ...((merged.customAttributes as Record<string, unknown>) || {}) };

    // Keys an owner cleared (`customAttributes.<key>` for custom attributes): no target fills them
    const cleared = new Set(ownerCleared);
    const droppingSource = sources.find((s) => s.sourceName === dropped?.sourceName);
    // A target never clears a field through a drop, not even one it masters
    if (droppingSource && dropped && !isTarget(droppingSource)) {
      for (const field of dropped.fields) {
        if (field.startsWith(CUSTOM)) {
          if (writeRule(droppingSource, 'customAttributes', field) === 'overwrite') {
            delete customAttrs[field.slice(CUSTOM.length)];
            cleared.add(field);
          }
        } else if (
          !targetIdKeys.has(field) &&
          !NEVER_CLEARED.has(field) &&
          writeRule(droppingSource, field) === 'overwrite'
        ) {
          // A key set to undefined unsets the field when the profile is assigned
          merged[field] = undefined;
          cleared.add(field);
        }
      }
    }
    /** May `rule` write `path` now? Records an overwrite as the end of an owner's clear. */
    const mayWrite = (rule: Exclude<WriteRule, null>, path: string): boolean => {
      if (rule === 'overwrite') cleared.delete(path);
      return rule === 'overwrite' || !cleared.has(path);
    };

    for (const source of sorted) {
      const raw = source.rawData || {};

      for (const [key, value] of Object.entries(raw)) {
        if (value === undefined || value === null || key === '_id') continue;

        // Target-specific IDs go to customAttributes, not root profile
        if (targetIdKeys.has(key)) {
          let attrKey = key;
          if (key === 'objectId') {
            attrKey = source.sourceName.toLowerCase().includes('entra')
              ? 'entraObjectId'
              : source.sourceName.toLowerCase().includes('ad')
                ? 'adDn'
                : 'objectId';
          } else if (key === 'objectGUID') {
            attrKey = 'adObjectGUID';
          }
          customAttrs[attrKey] = value;
          continue;
        }

        // Custom attributes merge one by one into the profile's customAttributes
        if (key === 'customAttributes' && typeof value === 'object' && !Array.isArray(value)) {
          for (const [customKey, customValue] of Object.entries(value as Record<string, unknown>)) {
            if (customValue === undefined || customValue === null) continue;
            const path = `${CUSTOM}${customKey}`;
            const customRule = writeRule(source, key, path);
            if (!customRule) continue;
            const existingCustom = customAttrs[customKey];
            if (customRule === 'fill' && existingCustom !== undefined && existingCustom !== null)
              continue;
            if (!mayWrite(customRule, path)) continue;
            customAttrs[customKey] = customValue;
          }
          continue;
        }

        const rule = writeRule(source, key);
        if (!rule) continue;
        const existing = merged[key];
        if (existing !== undefined && existing !== null && rule === 'fill') {
          continue; // Only the field's master, or an HR source, overwrites a value
        }
        if (!mayWrite(rule, key)) continue; // An owner cleared it: not from a target's copy
        // An enum field takes the value a stored record names ("active"), never one it cannot hold
        const fieldValue = profileValue(key, value);
        if (fieldValue === NOT_A_PROFILE_VALUE) {
          this.logger.warn(
            `[Reconcile] ${source.sourceName} record holds ${key} "${String(value).slice(0, 40)}", ` +
              'which is no value of that field: left out of the profile',
          );
          continue;
        }
        merged[key] = fieldValue;
      }
    }

    merged.customAttributes = Object.keys(customAttrs).length ? customAttrs : undefined;

    return {
      merged: merged as unknown as IdentityProfile,
      primaryHrSource,
      primaryContractExternalId,
      ownerClearedFields: [...cleared].sort(),
    };
  }

  /**
   * The HR source that masters each of `fields` for this identity: the HR source whose value the
   * next reconcile writes over the profile's (the overwrite rule of mergeSourcesIntoProfile: the
   * primary HR contract for a contract-critical field, else the field's master, else the first HR
   * source in the merge order with a value). A field no HR source overwrites (no HR value, a
   * target or nobody masters it) is left out: EuroID keeps its value and a manual edit persists.
   * Without `fields`: every field a source of the identity carries. PATCH /identity/:id refuses an
   * edit of a field listed here (IdentityMutationService), and the profile form shows it read-only.
   */
  async hrOwnersOf(identity: IdentityDocument, fields?: string[]): Promise<Record<string, string>> {
    const { reconConfig, priorityMap } = await this.loadMergeConfig(identity.tenantId);
    // Strictly: defaults lack the field mastery overrides, so the answer (and PATCH's 409) would
    // name owners the next reconcile does not apply
    const { fieldMasteryOverrides } = await this.correlationConfigService.getCorrelationConfig(
      identity.tenantId || 'default',
      { strict: true },
    );
    const sources = identity.sources || [];
    const rules = this.mergeRules(
      sources,
      identity.metadata?.mastery || {},
      fieldMasteryOverrides,
      priorityMap,
      reconConfig,
    );
    const targetIdKeys = new Set(reconConfig?.targetIdKeys ?? []);
    const keys =
      fields ?? [...new Set(sources.flatMap((s) => Object.keys(s.rawData || {})))].sort();
    const owners: Record<string, string> = {};
    for (const key of keys) {
      if (key === '_id' || key === 'customAttributes' || targetIdKeys.has(key)) continue;
      const owner = rules.sorted.find(
        (s) =>
          !rules.isTarget(s) && rules.carries(s, key) && rules.writeRule(s, key) === 'overwrite',
      );
      if (owner) owners[key] = owner.sourceName;
    }
    return owners;
  }

  /** The tenant's reconciliation config and the HR connectors' priorities reconcile merges by. */
  private async loadMergeConfig(tenantIdOfIdentity: string | undefined): Promise<{
    reconConfig: ReconciliationConfigDocument | null;
    priorityMap: Map<string, { priority: number; contractTag?: string }>;
  }> {
    const tenantId = tenantIdOfIdentity || 'default';
    const reconConfig = await this.reconConfigService.getConfig(tenantId);
    if (!reconConfig) {
      this.logger.warn(
        `[Reconcile] No reconciliation config for tenant ${tenantId}. Mastery enforcement skipped (open merge).`,
      );
    }
    const hrSourceTags = reconConfig?.hrSourceTags ?? [];
    const blueprintPriorities =
      await this.correlationConfigService.getHrConnectorsWithPriorityFromBlueprint(hrSourceTags);
    const connectorPriorities =
      blueprintPriorities.length > 0
        ? blueprintPriorities
        : await this.correlationConfigService.getInstalledHrConnectorsWithPriority(hrSourceTags);
    const priorityMap = new Map<string, { priority: number; contractTag?: string }>();
    for (const c of connectorPriorities) {
      priorityMap.set(c.name.toLowerCase(), {
        priority: c.ingestPriority,
        contractTag: c.contractTag,
      });
    }
    return { reconConfig, priorityMap };
  }

  /**
   * The merge rules of one identity's sources (see mergeSourcesIntoProfile): its primary HR
   * source, the merge order, which sources are targets, which carry a value, and how a source may
   * write a field.
   */
  private mergeRules(
    sources: LinkedAccount[],
    mastery: Record<string, string>,
    fieldMasteryOverrides?: Record<string, string[]>,
    connectorPriorityMap?: Map<string, { priority: number; contractTag?: string }>,
    reconConfig?: ReconciliationConfigDocument | null,
  ): MergeRules {
    const hrSourceTags = reconConfig?.hrSourceTags ?? [];
    const contractCriticalFields = new Set(reconConfig?.contractCriticalFields ?? []);
    const defaultMastery = reconConfig?.defaultMastery ?? {};
    const sourcePriorityOrder = reconConfig?.sourcePriorityOrder ?? [];

    const primary = this.resolvePrimaryHrSource(
      sources,
      connectorPriorityMap,
      hrSourceTags,
      sourcePriorityOrder,
    );
    const primaryHrSource = primary?.sourceName;
    const sorted = this.getMergeOrder(sources, primary, connectorPriorityMap, sourcePriorityOrder);
    const isHrSource = (name: string) =>
      hrSourceTags.some((hr) => name.toLowerCase().includes(hr)) ||
      (sources.find((s) => s.sourceName === name)?.sourceRole ?? '').includes('hr');
    const isTarget = (source: LinkedAccount) =>
      source.sourceRole === 'target' || !isHrSource(source.sourceName);
    /** Whether `source` has a value for `path` (a profile key, or `customAttributes.<key>`). */
    const carries = (source: LinkedAccount, path: string): boolean => {
      const raw = (source.rawData || {}) as Record<string, unknown>;
      if (!path.startsWith(CUSTOM)) return !isEmpty(raw[path]);
      const custom = raw.customAttributes as Record<string, unknown> | null | undefined;
      return (
        typeof custom === 'object' && custom !== null && !isEmpty(custom[path.slice(CUSTOM.length)])
      );
    };

    /** How `source` may write `key`; `path` is `customAttributes.<key>` for a custom attribute. */
    const writeRule = (source: LinkedAccount, key: string, path = key): WriteRule => {
      // Contract-critical: the primary HR contract always drives it (owner decision 2026-11-24).
      // No master applies: neither an explicit one (an HR source node's mastery fields) nor the
      // Brain's override or the default mastery, which the config saves refuse for these fields
      // when they name another source (contract-critical-mastery.ts).
      if (contractCriticalFields.has(key) && primaryHrSource) {
        return source.sourceName === primaryHrSource ? 'overwrite' : null;
      }

      // The field's masters, in order: its explicit master, else the Brain's field mastery
      // override (correlationConfig.fieldMasteryOverrides), else the tenant's default mastery.
      // An empty override list counts as unset.
      const explicit = mastery[key];
      const override = fieldMasteryOverrides?.[key];
      const masters = override?.length ? override : (defaultMastery[key] ?? []);
      if (!explicit && masters.length === 0) {
        // No master: an HR source writes unless one ahead of it in the merge order (the primary
        // first) has a value, so a secondary HR source supplements; a target only fills.
        if (isTarget(source)) return 'fill';
        const ahead = sorted.slice(0, sorted.indexOf(source));
        return ahead.some((s) => !isTarget(s) && carries(s, path)) ? null : 'overwrite';
      }
      const rankOf = (s: LinkedAccount): number => {
        if (explicit) return s.sourceName === explicit ? 0 : -1;
        return masters.findIndex((m) => s.sourceName.toLowerCase().includes(m.toLowerCase()));
      };
      // The master is the first listed source with a value: it overwrites (a target too), and no
      // other source changes the field. While none has a value, any other source fills it.
      const ranks = sources
        .filter((s) => carries(s, path))
        .map(rankOf)
        .filter((r) => r >= 0);
      const master = ranks.length ? Math.min(...ranks) : undefined;
      const rank = rankOf(source);
      if (rank < 0) return master === undefined ? 'fill' : null;
      return master === undefined || rank === master ? 'overwrite' : null;
    };

    return { primary, sorted, isTarget, carries, writeRule };
  }

  /**
   * Resolve the primary HR source: one whose record declares the primary contract
   * (contractType), else one whose connector is tagged PRIMARY, else one with the primary-hr role,
   * else any HR source. Several at that level (two HR source nodes that both keep the Design
   * Studio default tag PRIMARY) are ordered by the configured source priority, so every identity
   * has the same primary: the first source in the identity's list is the one that minted it.
   */
  private resolvePrimaryHrSource(
    sources: LinkedAccount[],
    connectorPriorityMap?: Map<string, { priority: number; contractTag?: string }>,
    hrSourceTags: string[] = [],
    sourcePriorityOrder: string[] = [],
  ): LinkedAccount | undefined {
    const hrSources = sources.filter(
      (s) =>
        hrSourceTags.some((hr) => s.sourceName.toLowerCase().includes(hr)) ||
        s.sourceRole === 'primary-hr' ||
        s.sourceRole === 'secondary-hr',
    );
    const levels = [
      hrSources.filter((s) => s.contractType === 'primary'),
      hrSources.filter(
        (s) => connectorPriorityMap?.get(s.sourceName.toLowerCase())?.contractTag === 'PRIMARY',
      ),
      hrSources.filter((s) => s.sourceRole === 'primary-hr'),
      hrSources,
    ];
    const candidates = levels.find((level) => level.length > 0) ?? [];
    const orderOf = (s: LinkedAccount): number => {
      const index = sourcePriorityOrder.indexOf(s.sourceName.toLowerCase());
      return index === -1 ? 999 : index;
    };
    // The connector's ingest priority (Recon Config's order for a source without a connector
    // entry, as in the merge order), then Recon Config's order, then the name
    const priorityOf = (s: LinkedAccount): number =>
      connectorPriorityMap?.get(s.sourceName.toLowerCase())?.priority ?? orderOf(s);
    return [...candidates].sort(
      (a, b) =>
        priorityOf(a) - priorityOf(b) ||
        orderOf(a) - orderOf(b) ||
        a.sourceName.localeCompare(b.sourceName),
    )[0];
  }

  /** Merge order: primary HR first, then others by connector ingestPriority or sourcePriorityOrder. */
  private getMergeOrder(
    sources: LinkedAccount[],
    primary: LinkedAccount | undefined,
    connectorPriorityMap?: Map<string, { priority: number; contractTag?: string }>,
    sourcePriorityOrder: string[] = [],
  ): LinkedAccount[] {
    const rest = primary ? sources.filter((s) => s.sourceName !== primary.sourceName) : sources;
    const sorted = [...rest].sort((a, b) => {
      const aKey = a.sourceName.toLowerCase();
      const bKey = b.sourceName.toLowerCase();
      const aP =
        connectorPriorityMap?.get(aKey)?.priority ??
        (sourcePriorityOrder.indexOf(aKey) === -1 ? 999 : sourcePriorityOrder.indexOf(aKey));
      const bP =
        connectorPriorityMap?.get(bKey)?.priority ??
        (sourcePriorityOrder.indexOf(bKey) === -1 ? 999 : sourcePriorityOrder.indexOf(bKey));
      return aP - bP;
    });
    return primary ? [primary, ...sorted] : sorted;
  }

  /**
   * The profile's fields as a plain object. A hydrated profile is a Mongoose subdocument, whose
   * spread holds only internals (`$__`, `_doc`), never the field values.
   */
  private profileToPlain(p: IdentityProfile | undefined): Record<string, unknown> {
    const doc = p as unknown as { toObject?: () => Record<string, unknown> } | undefined;
    if (typeof doc?.toObject === 'function') return doc.toObject();
    return { ...(p ?? {}) } as Record<string, unknown>;
  }

  /**
   * Reconcile by identity ID (load from DB then reconcile).
   */
  async reconcileById(identityId: string): Promise<IdentityDocument | null> {
    const identity = await this.identityModel.findById(identityId).exec();
    if (!identity) return null;
    return this.reconcile(identity);
  }

  /**
   * Reconcile by profile email (load from DB then reconcile).
   */
  async reconcileByEmail(email: string): Promise<IdentityDocument | null> {
    const identity = await this.identityModel
      .findOne({ 'profile.email': normalizeEmail(email) })
      .exec();
    if (!identity) return null;
    return this.reconcile(identity);
  }
}

// ── TASK 106 RECAP ──
// Modified: reconcile() accepts optional session param; passes it to identity.save() for transactional consistency.
