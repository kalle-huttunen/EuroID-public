import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';
import type { Identity, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { normalizeEmail } from '@shared/utils/email';
import type { Collection } from 'mongodb';
import type { CorrelationConfig } from '@shared/types/correlation-config';
import {
  cleanStoredNationalIdsAfterSave,
  type StoredNationalIdCleanup,
} from './national-id-cleanup';
import { NOT_DELETED, DEFAULT_TENANT } from './identity.constants';
import {
  toAccessBaseline,
  type AccessBaseline,
  type AccessBaselineAttributes,
} from '@shared/utils/access-baseline';
import {
  contractValue,
  controlledContractValue,
  type ContractAttribute,
} from './manual-contract-overrides';
import { controlValue } from './attribute-controls';

/**
 * Onion Model: Identity document finders + contract builder for policy evaluation, and the
 * access baseline built from that policy profile (shared/utils/access-baseline.ts).
 */
@Injectable()
export class IdentityOnionService {
  private readonly logger = this.loggerFactory.create(IdentityOnionService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly reconConfigService: ReconciliationConfigService,
    private readonly loggerFactory: LoggerFactoryService,
  ) {}

  /**
   * Derive contracts from Identity sources for policy evaluation.
   * Each HR source (or source with title/department) becomes a contract. An attribute control
   * (controls.manualDepartment / manualJobTitle) replaces the value of the primary HR contract and
   * of the contracts holding the same value while it is set, as reconcile does in the profile
   * (controlledContractValue). Else a department or title edited by hand replaces the HR value it
   * overrides (metadata.manualOverrides) until HR sends another one (manual-contract-overrides.ts).
   * Accepts a hydrated document or a lean object: a hydrated profile is a subdocument, and
   * spreading it would copy Mongoose internals instead of the profile fields.
   */
  async buildProfileWithContractsForPolicy(
    identity: IdentityDocument,
  ): Promise<Record<string, unknown>> {
    const plain = (
      typeof identity.toObject === 'function' ? identity.toObject() : identity
    ) as Identity;
    const profile = (plain.profile as unknown as Record<string, unknown>) || {};
    const sources = plain.sources || [];
    const primaryHr = plain.metadata?.primaryHrSource;
    const overrides = plain.metadata?.manualOverrides;
    const controls = plain.controls;
    const tenantId = plain.tenantId || DEFAULT_TENANT;
    const hrSourceTags = await this.reconConfigService.getHrSourceTags(tenantId);
    const contracts: Array<{
      id: string;
      title: string;
      department: string;
      isPrimary?: boolean;
      status: string;
    }> = [];
    const hrSources = sources.filter(
      (s) =>
        hrSourceTags.some((hr) => (s.sourceName || '').toLowerCase().includes(hr)) ||
        s.sourceRole === 'primary-hr' ||
        s.sourceRole === 'secondary-hr',
    );
    // The contract the profile takes its department and title from (reconcile's primary)
    const primary =
      hrSources.find((s) => s.sourceName === primaryHr) ??
      hrSources.find((s) => s.contractType === 'primary') ??
      hrSources[0];
    const valueOf = (attribute: ContractAttribute, s: (typeof hrSources)[number]) =>
      controlledContractValue(attribute, s, primary, controlValue(controls, attribute)) ??
      contractValue(attribute, s, profile, overrides);
    for (let i = 0; i < hrSources.length; i++) {
      const s = hrSources[i];
      const title = valueOf('jobTitle', s);
      const dept = valueOf('departmentName', s);
      if (!title && !dept) continue;
      const isPrimary = s.sourceName === primaryHr || s.contractType === 'primary' || i === 0;
      contracts.push({
        id: (s.externalId as string) || `c-${i}`,
        title: String(title || ''),
        department: String(dept || ''),
        isPrimary,
        status: 'ACTIVE',
      });
    }
    return { ...profile, contracts: contracts.length > 0 ? contracts : undefined };
  }

  /**
   * After the Brain's correlation settings are saved: the values stored under a national ID field
   * the rule names anew are removed from the tenant's identities
   * (cleanStoredNationalIdsAfterSave). Null when the settings name no new field.
   */
  cleanStoredNationalIds(
    tenantId: string,
    previous: CorrelationConfig | undefined,
    saved: CorrelationConfig | undefined,
  ): Promise<StoredNationalIdCleanup | null> {
    const identities = this.identityModel.collection as unknown as Collection;
    return cleanStoredNationalIdsAfterSave(identities, tenantId, previous, saved, this.logger);
  }

  /**
   * Find Identity document by profile email.
   * Excludes soft-deleted by default.
   */
  async findIdentityByEmail(
    email: string,
    options?: { includeDeleted?: boolean; tenantId?: string },
  ): Promise<IdentityDocument | null> {
    const tid = options?.tenantId || requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const filter: Record<string, unknown> = {
      'profile.email': normalizeEmail(email),
      tenantId: tid,
    };
    if (!options?.includeDeleted) Object.assign(filter, NOT_DELETED);
    return this.identityModel.findOne(filter).exec();
  }

  /**
   * Find Identity by ID.
   * Excludes soft-deleted by default.
   */
  async findIdentityById(
    id: string,
    options?: { includeDeleted?: boolean; tenantId?: string },
  ): Promise<IdentityDocument | null> {
    const tid = options?.tenantId || requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const filter: Record<string, unknown> = { _id: id, tenantId: tid };
    if (!options?.includeDeleted) Object.assign(filter, NOT_DELETED);
    return this.identityModel.findOne(filter).exec();
  }

  /**
   * Find Identity by source key (sourceName + externalId).
   * Uses the composite key from external systems: one source must hold both, or an identity
   * whose one source has the name and another source the id would match.
   * Excludes soft-deleted by default.
   */
  async findIdentityBySourceKey(
    sourceName: string,
    externalId: string,
    tenantId: string,
    options?: { includeDeleted?: boolean; session?: ClientSession },
  ): Promise<IdentityDocument | null> {
    const filter: Record<string, unknown> = {
      tenantId,
      sources: { $elemMatch: { sourceName, externalId } },
    };
    if (!options?.includeDeleted) Object.assign(filter, NOT_DELETED);
    let q = this.identityModel.findOne(filter);
    if (options?.session) q = q.session(options.session);
    return q.exec();
  }

  /**
   * Record the identity's access baseline from its policy profile now, when it has none yet (the
   * first SYNCED target: what onboarding evaluated). Tenant from the context. Atomic: of
   * concurrent calls one writes. True when it wrote.
   */
  async recordInitialAccessBaseline(identityId: string): Promise<boolean> {
    const tenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const missing = { _id: identityId, tenantId, accessBaseline: { $exists: false } };
    const identity = await this.identityModel.findOne({ ...missing, ...NOT_DELETED }).exec();
    if (!identity) return false;
    const baseline: AccessBaseline = {
      attributes: toAccessBaseline(await this.buildProfileWithContractsForPolicy(identity)),
      recordedAt: new Date(),
      recordedBy: 'provisioning',
    };
    const result = await this.identityModel
      .updateOne(missing, { $set: { accessBaseline: baseline } })
      .exec();
    return result.modifiedCount > 0;
  }

  /**
   * A completed mover run applied `applied` (attribute -> the value it evaluated): those
   * attributes of the baseline take these values; the others keep theirs. Without a baseline the
   * identity gets its first one (recordInitialAccessBaseline). Tenant from the context.
   */
  async advanceAccessBaseline(
    identityId: string,
    applied: AccessBaselineAttributes,
  ): Promise<void> {
    const tenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const set: Record<string, unknown> = {
      'accessBaseline.recordedAt': new Date(),
      'accessBaseline.recordedBy': 'mover',
    };
    for (const [key, value] of Object.entries(toAccessBaseline(applied))) {
      set[`accessBaseline.attributes.${key}`] = value ?? null;
    }
    const result = await this.identityModel
      .updateOne({ _id: identityId, tenantId, accessBaseline: { $exists: true } }, { $set: set })
      .exec();
    if (result.matchedCount === 0) await this.recordInitialAccessBaseline(identityId);
  }
}
