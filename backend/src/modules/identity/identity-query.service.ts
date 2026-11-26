import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as mongoose from 'mongoose';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import type { IdentityDocument } from './schemas/identity.schema';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { NOT_DELETED, DEFAULT_TENANT, IDENTITY_PAGE_MAX } from './identity.constants';
import { projectIdentityToUser } from './identity-helpers';
import type { IdentityLike } from './identity-helpers';
import { paginateQuery } from '@shared/utils/paginate-query';
import { normalizeEmail } from '@shared/utils/email';
import { validateFilterKeys, IDENTITY_ALLOWED_FILTER_KEYS } from '@shared/utils/filter-validator';
import { identitySearchFilter } from './identity-search';
import { identityScanScopeClauses } from './identity-scan-scope';
import { identityFilterQuery } from './identity-list-query';
import { liveEmployeeIdFilter } from './identity-employee-id';
import type { ReconciliationScope } from '@shared/utils/reconciliation-scope';

/**
 * Identity read operations: listing, lookup, pagination.
 */
@Injectable()
export class IdentityQueryService {
  private readonly logger = this.loggerFactory.create(IdentityQueryService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly loggerFactory: LoggerFactoryService,
  ) {}

  /**
   * Identities per profile status in every tenant, a soft-deleted one as DELETED and one without
   * a status as UNKNOWN (the euroid_identities_total gauge, read when Prometheus scrapes, outside
   * any tenant context).
   */
  async countByStatusInAllTenants(): Promise<Record<string, number>> {
    const groups = await this.identityModel
      .aggregate<{ _id: string; count: number }>([
        {
          $group: {
            _id: {
              $cond: [
                { $ifNull: ['$deletedAt', false] },
                'DELETED',
                { $ifNull: ['$profile.status', 'UNKNOWN'] },
              ],
            },
            count: { $sum: 1 },
          },
        },
      ])
      .option({ skipTenantScope: true })
      .exec();
    return Object.fromEntries(groups.map((g) => [g._id, g.count]));
  }

  /**
   * List all users. Excludes soft-deleted by default.
   * @deprecated Use findAllPaginated for large datasets.
   */
  async findAll(options?: {
    includeDeleted?: boolean;
    employmentTypes?: string[];
    includeSources?: boolean;
    /** Add the provisioning entries (per-target status), e.g. for access review account items. */
    includeProvisioning?: boolean;
  }): Promise<Record<string, unknown>[]> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const filter: Record<string, unknown> = options?.includeDeleted
      ? { tenantId: tid }
      : { ...NOT_DELETED, tenantId: tid };
    if (options?.employmentTypes?.length) {
      filter['profile.employmentType'] = { $in: options.employmentTypes };
    }
    const identities = await this.identityModel.find(filter).lean().exec();
    return identities.map((doc) => {
      const base = projectIdentityToUser(doc as IdentityLike);
      if (options?.includeSources && (doc as IdentityLike).sources?.length) {
        base.sources = (doc as IdentityLike).sources;
      }
      if (options?.includeProvisioning) {
        base.provisioning = (doc as { provisioning?: unknown }).provisioning;
      }
      return base;
    });
  }

  /**
   * Paginated listing with Refine _start/_end.
   * Returns [data, total] for GET /identity with X-Total-Count header. `search`: every word in
   * the work email or a name (identitySearchFilter). `includeDeleted`: soft-deleted identities
   * too, each carrying its `deletedAt`.
   */
  async findAllPaginated(
    start?: number,
    end?: number,
    options?: {
      includeDeleted?: boolean;
      filter?: Record<string, unknown>;
      trustedFilter?: boolean;
      search?: string;
    },
  ): Promise<[Record<string, unknown>[], number]> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const filter: Record<string, unknown> = options?.includeDeleted
      ? { tenantId: tid }
      : { ...NOT_DELETED, tenantId: tid };
    if (options?.filter && Object.keys(options.filter).length > 0) {
      if (options.trustedFilter) {
        Object.assign(filter, options.filter);
      } else {
        validateFilterKeys(options.filter, IDENTITY_ALLOWED_FILTER_KEYS);
        Object.assign(filter, identityFilterQuery(options.filter));
      }
      // Re-apply tenantId unconditionally — user filters must never override tenant isolation
      filter.tenantId = tid;
      if (!options?.includeDeleted) Object.assign(filter, NOT_DELETED);
    }
    if (options?.search?.trim()) Object.assign(filter, identitySearchFilter(options.search));
    const skip = start == null || end == null ? 0 : Math.max(0, start);
    const rawLimit = start != null && end != null ? Math.max(1, end - skip) : IDENTITY_PAGE_MAX;
    const limit = Math.min(rawLimit, IDENTITY_PAGE_MAX);
    const result = await paginateQuery(this.identityModel, filter, { skip, limit });
    const data = result.items.map((doc) => {
      const user = projectIdentityToUser(doc as IdentityLike);
      const deletedAt = (doc as { deletedAt?: Date | null }).deletedAt;
      return options?.includeDeleted && deletedAt ? { ...user, deletedAt } : user;
    });
    return [data, result.total];
  }

  async findOne(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Record<string, unknown> | null> {
    return this.findById(id, options);
  }

  async findById(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Record<string, unknown> | null> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const filter: Record<string, unknown> = { _id: id, tenantId: tid };
    if (!options?.includeDeleted) Object.assign(filter, NOT_DELETED);
    const identity = await this.identityModel.findOne(filter).lean().exec();
    if (!identity) return null;
    return projectIdentityToUser(identity as IdentityLike);
  }

  /**
   * The work email of the live identity each employee id names in the current tenant
   * (`profile.employeeId`, read through EMPLOYEE_ID_INDEX), by employee id. An id no live
   * identity has, or two or more have, or whose identity has no email, is left out: it names no
   * one person.
   */
  async findEmailsByEmployeeIds(employeeIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(employeeIds.map((id) => String(id).trim()).filter(Boolean))];
    const found = new Map<string, string>();
    if (ids.length === 0) return found;
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const docs = await this.identityModel
      .find(liveEmployeeIdFilter(tid, ids))
      .select({ 'profile.employeeId': 1, 'profile.email': 1 })
      .lean()
      .exec();
    const ambiguous = new Set<string>();
    for (const doc of docs) {
      const id = doc.profile?.employeeId;
      if (!id) continue;
      if (found.has(id) || ambiguous.has(id)) {
        found.delete(id);
        ambiguous.add(id);
      } else if (doc.profile?.email) {
        found.set(id, doc.profile.email);
      } else {
        ambiguous.add(id);
      }
    }
    return found;
  }

  async findByEmail(
    email: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Record<string, unknown> | null> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const filter: Record<string, unknown> = {
      'profile.email': normalizeEmail(email),
      tenantId: tid,
    };
    if (!options?.includeDeleted) Object.assign(filter, NOT_DELETED);
    const identity = await this.identityModel.findOne(filter).lean().exec();

    if (identity) {
      const plainUser = projectIdentityToUser(identity as IdentityLike);
      const fieldsWithValues = Object.keys(plainUser).filter(
        (k) => plainUser[k] !== null && plainUser[k] !== undefined,
      );
      this.logger.debug(`[findByEmail] Found user with ${fieldsWithValues.length} fields`);
      this.logger.debug(`[findByEmail] Field names: ${fieldsWithValues.join(', ')}`);
      return plainUser;
    }

    return null;
  }

  /**
   * Stream users in pages to avoid OOM at scale.
   * Returns skip-based pagination. When skip=0, also returns total count.
   * `scope`: a reconciliation run's includedDepartments and excludedUsers, applied to the count
   * and to every page alike (identity-scan-scope.ts).
   */
  async findUsersPageForReconciliation(
    skip: number,
    limit: number,
    scope?: ReconciliationScope,
  ): Promise<{ users: Record<string, unknown>[]; total?: number }> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const clauses = identityScanScopeClauses(scope);
    const filter = {
      ...NOT_DELETED,
      tenantId: tid,
      ...(clauses.length > 0 ? { $and: clauses } : {}),
    };
    const [identities, total] = await Promise.all([
      this.identityModel.find(filter).skip(skip).limit(limit).sort({ _id: 1 }).lean().exec(),
      skip === 0 ? this.identityModel.countDocuments(filter).exec() : Promise.resolve(0),
    ]);
    const users = identities.map((doc) => projectIdentityToUser(doc as IdentityLike));
    return { users, total: skip === 0 ? total : undefined };
  }

  /**
   * Find a single user by id, email, or sourceUserId for on-demand reconciliation.
   */
  async findUserForReconciliation(userId: string): Promise<Record<string, unknown> | null> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const identityOr: Record<string, unknown>[] = [
      { 'profile.email': userId },
      { 'profile.sourceUserId': userId },
      { 'sources.externalId': userId },
    ];
    if (
      mongoose.Types.ObjectId.isValid(userId) &&
      String(new mongoose.Types.ObjectId(userId)) === userId
    ) {
      identityOr.unshift({ _id: userId });
    }
    const identity = await this.identityModel
      .findOne({ ...NOT_DELETED, tenantId: tid, $or: identityOr })
      .lean()
      .exec();
    if (!identity) return null;
    return projectIdentityToUser(identity as IdentityLike);
  }

  /**
   * Of `keys` (a page of target accounts' UPNs, mails, ids and objectGUIDs), the ones a live
   * identity of the tenant has, as findUserForReconciliation matches one (profile.email,
   * profile.sourceUserId, sources.externalId, _id), counting only identities with a status other
   * than TERMINATED or DELETED: one query for what orphan detection asked key by key.
   */
  async findLiveOwnerKeys(keys: string[]): Promise<Set<string>> {
    const wanted = new Set(keys.filter((k) => typeof k === 'string' && k !== ''));
    if (wanted.size === 0) return new Set();
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const values = [...wanted];
    const objectIds = values.filter(
      (k) => mongoose.Types.ObjectId.isValid(k) && String(new mongoose.Types.ObjectId(k)) === k,
    );
    const owners = await this.identityModel
      .find({
        ...NOT_DELETED,
        tenantId: tid,
        'profile.status': { $exists: true, $nin: [UserStatus.TERMINATED, UserStatus.DELETED] },
        $or: [
          { 'profile.email': { $in: values } },
          { 'profile.sourceUserId': { $in: values } },
          { 'sources.externalId': { $in: values } },
          ...(objectIds.length > 0 ? [{ _id: { $in: objectIds } }] : []),
        ],
      })
      .select('profile.email profile.sourceUserId sources.externalId')
      .lean()
      .exec();
    const owned = new Set<string>();
    for (const owner of owners as Array<{
      _id: unknown;
      profile?: { email?: string; sourceUserId?: string };
      sources?: Array<{ externalId?: string }>;
    }>) {
      const held = [
        String(owner._id),
        owner.profile?.email,
        owner.profile?.sourceUserId,
        ...(owner.sources ?? []).map((source) => source.externalId),
      ];
      for (const key of held) if (key && wanted.has(key)) owned.add(key);
    }
    return owned;
  }

  async findUsersByTag(tag: string): Promise<Record<string, unknown>[]> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const identities = await this.identityModel
      .find({ 'profile.tags': tag, ...NOT_DELETED, tenantId: tid })
      .lean()
      .exec();
    return identities.map((doc) => projectIdentityToUser(doc as IdentityLike));
  }

  async findUsersByTagAndStatus(
    tag: string,
    status: UserStatus,
  ): Promise<Record<string, unknown>[]> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const identities = await this.identityModel
      .find({ 'profile.tags': tag, 'profile.status': status, ...NOT_DELETED, tenantId: tid })
      .lean()
      .exec();
    return identities.map((doc) => projectIdentityToUser(doc as IdentityLike));
  }

  async deleteUsersByTag(tag: string): Promise<{ deletedCount: number }> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const result = await this.identityModel
      .deleteMany({ 'profile.tags': tag, tenantId: tid })
      .exec();
    return { deletedCount: result.deletedCount };
  }
}
