import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { IdentityDocument, LinkedAccount, ProvisioningState } from './schemas/identity.schema';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { NOT_DELETED, DEFAULT_TENANT } from './identity.constants';
import { IDENTITY_PROVISIONING_PAGE_SIZE } from '@infrastructure/config/defaults';
import { saveWithRetry, ensureTenantId, deduplicateAndValidateSources } from './identity-helpers';
import { normalizeSystemName, getSystemType } from '@shared/utils/normalize-system-name';

/**
 * The account id in `targetSystem`: the externalId of the identity's target source (writeback,
 * orphan adoption) for that system. Names match exactly once normalised (case, dashes), or as
 * aliases of one known system (`entra` / `entra-id`, `ad` / `active-directory`). An HR source
 * never matches: its externalId is an employee id, not an account in the target.
 */
export function targetAccountId(
  sources: Array<Pick<LinkedAccount, 'sourceName' | 'externalId' | 'sourceRole'>> | undefined,
  targetSystem: string,
): string | undefined {
  const source = (sources || []).find(
    (s) => s.sourceRole === 'target' && sameSystem(s.sourceName, targetSystem),
  );
  return source?.externalId;
}

/** Same system: equal once normalised, or aliases of one known system. */
function sameSystem(name: string, targetSystem: string): boolean {
  if (normalizeSystemName(name) === normalizeSystemName(targetSystem)) return true;
  const tsType = getSystemType(targetSystem);
  return tsType !== 'unknown' && getSystemType(name) === tsType;
}

/**
 * The identity's account id in `targetSystem` (targetAccountId) while that account exists by
 * the identity's provisioning entry for the system: none once a deprovision removed it
 * (DEPROVISIONED, or `provisionedAt` null: not SYNCED since a deprovision), because the id
 * written back then describes the removed account. Without an entry for the system (an adopted
 * orphan account) the id stays. Provisioning finds the account by it: an id the target no
 * longer knows is a failure for an admin to check, never a reason to create a second account.
 */
export function liveTargetAccountId(
  identity: { sources?: LinkedAccount[]; provisioning?: ProvisioningState[] },
  targetSystem: string,
): string | undefined {
  const accountId = targetAccountId(identity.sources, targetSystem);
  if (!accountId) return undefined;
  return targetAccountRemoved(identity, targetSystem) ? undefined : accountId;
}

/**
 * Whether the identity's provisioning entry for `targetSystem` says a deprovision removed its
 * account (DEPROVISIONED, or `provisionedAt` null: not SYNCED since a deprovision).
 */
function targetAccountRemoved(
  identity: { provisioning?: ProvisioningState[] },
  targetSystem: string,
): boolean {
  const entry = (identity.provisioning ?? []).find((p) => sameSystem(p.targetSystem, targetSystem));
  return entry?.status === 'DEPROVISIONED' || entry?.provisionedAt === null;
}

/** What recordTargetAccountId did (see there). */
export type RecordTargetAccountOutcome =
  | 'recorded'
  | 'already'
  | 'other-recorded'
  | 'removed'
  | 'taken'
  | 'not-found';

/**
 * Whether the identity has an account in the entry's target system: once provisioned, until a
 * deprovision, also while a later run there is in ERROR (the mover changes access there and
 * retries a failed change; plan 2.0dq). `accountId` is targetAccountId for the entry's system.
 * - DEPROVISIONED: no.
 * - SYNCED, or `provisionedAt` set (it was SYNCED at a write since 2.0dq): yes.
 * - `provisionedAt` null (deprovisioned, not SYNCED since): no. Its writebackComplete and
 *   account id describe the account the deprovision removed.
 * - No `provisionedAt` (no write since 2.0dq, or never SYNCED): `writebackComplete` (onboarding
 *   sets it only together with SYNCED), or ERROR with the account id the target wrote back
 *   (onboarding writes it back once the target answered with the account, also when a later
 *   change failed, e.g. an Entra ID group).
 * None of these can be an account that was never created.
 */
export function hasProvisionedAccount(
  entry: Pick<ProvisioningState, 'status' | 'provisionedAt' | 'writebackComplete'>,
  accountId: string | undefined,
): boolean {
  if (entry.status === 'DEPROVISIONED') return false;
  if (entry.status === 'SYNCED' || entry.provisionedAt) return true;
  if (entry.provisionedAt === null) return false;
  return entry.writebackComplete === true || (entry.status === 'ERROR' && !!accountId);
}

/**
 * The target systems the identity has an account in (hasProvisionedAccount): where the mover
 * changes its access, and the one rule for whether a mover run applies at all (re-evaluation, HR
 * mover detection, an edit's identity.updated). Provisioned once, until a deprovision, so a
 * system whose last run failed (the mover's own ERROR among them) still counts. Not an entry that
 * never synced and holds no account id the target wrote back, or a DEPROVISIONED one.
 */
export function provisionedSystems(identity: {
  provisioning?: Array<
    Pick<ProvisioningState, 'targetSystem' | 'status' | 'provisionedAt' | 'writebackComplete'>
  > | null;
  sources?: Array<Pick<LinkedAccount, 'sourceName' | 'externalId' | 'sourceRole'>>;
}): string[] {
  const systems = (identity.provisioning ?? [])
    .filter((p) => hasProvisionedAccount(p, targetAccountId(identity.sources, p.targetSystem)))
    .map((p) => p.targetSystem);
  return [...new Set(systems)];
}

/**
 * Provisioning state lifecycle: onboarding finders, deprovision targets, status tracking.
 */
@Injectable()
export class IdentityProvisioningService {
  private readonly logger = this.loggerFactory.create(IdentityProvisioningService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly loggerFactory: LoggerFactoryService,
  ) {}

  /**
   * Find identities suitable for onboarding (multi-HR aware).
   * @deprecated For large datasets use findIdentitiesForOnboardingPaginated in a loop.
   */
  async findIdentitiesForOnboarding(): Promise<IdentityDocument[]> {
    const all: IdentityDocument[] = [];
    let skip = 0;
    let batch: IdentityDocument[];
    do {
      batch = await this.findIdentitiesForOnboardingPaginated(
        skip,
        IDENTITY_PROVISIONING_PAGE_SIZE,
      );
      all.push(...batch);
      skip += IDENTITY_PROVISIONING_PAGE_SIZE;
    } while (batch.length === IDENTITY_PROVISIONING_PAGE_SIZE);
    return all;
  }

  /**
   * Paginated version of findIdentitiesForOnboarding, in _id order: skip and limit over an
   * unsorted query can skip or repeat identities while the collection changes between pages.
   */
  async findIdentitiesForOnboardingPaginated(
    skip: number,
    limit: number,
  ): Promise<IdentityDocument[]> {
    const tid = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    return this.identityModel
      .find({
        ...NOT_DELETED,
        tenantId: tid,
        'profile.status': 'ACTIVE',
        'profile.email': { $exists: true, $ne: '' },
      })
      .sort({ _id: 1 })
      .skip(skip)
      .limit(limit)
      .exec();
  }

  /**
   * Get targets where the identity is provisioned (SYNCED) for offboarding deprovision.
   * Offboarding histories from before the patch offboarding:unsynced-targets replay with it.
   */
  async getProvisionedTargetsForDeprovision(
    identityId: string,
    tenantId: string,
  ): Promise<Array<{ targetSystem: string; externalId?: string }>> {
    const identity = await this.identityModel
      .findOne({ _id: identityId, tenantId, ...NOT_DELETED })
      .exec();
    if (!identity?.provisioning?.length) return [];
    return identity.provisioning
      .filter((p) => p.status === 'SYNCED')
      .map((p) => ({
        targetSystem: p.targetSystem,
        externalId: this.accountIdFor(identity, p.targetSystem),
      }));
  }

  /**
   * Offboarding targets: every provisioning entry not yet DEPROVISIONED (SYNCED, and SYNCING,
   * ERROR or PENDING, which may hold a half-created account), with its status and the account
   * id from the identity's account record. `noProvisioningState` is true only for an identity
   * that exists and has no provisioning entry at all (provisioned before tracking); an identity
   * not found (deleted meanwhile) has nothing to remove.
   *
   * An admin identity (PAM, `parentIdentityId`) also has its DEPROVISIONED entries targeted,
   * except those a deprovision through updateProvisioningState recorded (`provisionedAt` null):
   * PAM deactivation was written to mark every entry DEPROVISIONED, keeping its other fields,
   * without removing anything in the targets, so such a status says nothing about the account.
   * Only one whose account id is stored (Entra ID object id, AD DN, SCIM id): the deprovision
   * finds the account by it and reports it already gone when it is. Without one (an entry
   * deprovisioned before the marker existed has no `provisionedAt` at all) the deprovision
   * would fail on every rerun and keep the person suspended for an account that is gone.
   */
  async getOffboardingTargets(
    identityId: string,
    tenantId: string,
  ): Promise<{
    noProvisioningState: boolean;
    targets: Array<{ targetSystem: string; externalId?: string; status: string }>;
  }> {
    const identity = await this.identityModel
      .findOne({ _id: identityId, tenantId, ...NOT_DELETED })
      .exec();
    const provisioning = identity?.provisioning ?? [];
    const accountId = (targetSystem: string) =>
      identity ? this.accountIdFor(identity, targetSystem) : undefined;
    return {
      noProvisioningState: Boolean(identity) && provisioning.length === 0,
      targets: provisioning
        .filter(
          (p) =>
            p.status !== 'DEPROVISIONED' ||
            (Boolean(identity?.parentIdentityId) &&
              p.provisionedAt !== null &&
              Boolean(accountId(p.targetSystem))),
        )
        .map((p) => ({
          targetSystem: p.targetSystem,
          externalId: accountId(p.targetSystem),
          status: p.status,
        })),
    };
  }

  /**
   * The account id in `targetSystem` (targetAccountId). Offboarding and entitlement expiry read
   * the account to deprovision through it.
   */
  accountIdFor(identity: IdentityDocument, targetSystem: string): string | undefined {
    return targetAccountId(identity.sources, targetSystem);
  }

  /**
   * Records `accountId` as the identity's account in `targetSystem`: its target source (no raw
   * data), where liveTargetAccountId, offboarding and expiry read the account id. For an account
   * found or created outside onboarding's write-back: an access request's read-only lookup of an
   * account with no recorded id, a bulk CREATE. It writes that and nothing else: the profile is
   * not reconciled, no provisioning entry is added or changed, no identity is created.
   * - `recorded`: added;
   * - `already`: the identity has this id recorded; `other-recorded`: another one, which stays
   *   (an id is never replaced here);
   * - `removed`: the identity's entry for the system says a deprovision removed its account, so
   *   no account found now is taken for it (onboarding provisions it again);
   * - `taken`: another live identity of the tenant has this account;
   * - `not-found`: no live identity with the id in the tenant (from the request context).
   */
  async recordTargetAccountId(
    identityId: string,
    targetSystem: string,
    accountId: string,
  ): Promise<RecordTargetAccountOutcome> {
    const tenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const holders = await this.identityModel
      .find({
        tenantId,
        ...NOT_DELETED,
        _id: { $ne: identityId },
        sources: { $elemMatch: { sourceRole: 'target', externalId: accountId } },
      })
      .select('sources')
      .lean()
      .exec();
    if (holders.some((h) => targetAccountId(h.sources, targetSystem) === accountId)) return 'taken';

    let outcome: RecordTargetAccountOutcome = 'not-found';
    await saveWithRetry(
      () => this.identityModel.findOne({ _id: identityId, tenantId, ...NOT_DELETED }).exec(),
      (doc) => {
        const recorded = targetAccountId(doc.sources, targetSystem);
        if (targetAccountRemoved(doc, targetSystem)) {
          outcome = 'removed';
        } else if (recorded) {
          outcome = recorded === accountId ? 'already' : 'other-recorded';
        } else {
          const source = {
            sourceName: targetSystem,
            externalId: accountId,
            sourceRole: 'target',
            lastSync: new Date(),
            rawData: {},
          } as LinkedAccount;
          doc.sources = deduplicateAndValidateSources([...(doc.sources ?? []), source]);
          outcome = 'recorded';
        }
      },
      `recordTargetAccountId(${identityId},${targetSystem})`,
      this.logger,
    );
    return outcome;
  }

  /**
   * Update provisioning state for one target. Creates the entry if missing. Records
   * `provisionedAt` when the entry is SYNCED, or was SYNCED before this write (an entry from
   * before the marker), and keeps it; a deprovision sets it to null, as does the first write
   * after a deprovision from before the marker (hasProvisionedAccount). A deprovision (offboarding,
   * expiry, an access review revoke) also undoes the writeback (`writebackComplete` false), so
   * onboarding writes back the account a later provision creates (writeback-until-complete).
   * @param writebackComplete - Set true after first writeback to prevent circular writeback.
   * @param expiresAt - Time-bound access: when this provisioning entry expires.
   * @param activeFrom - Time-bound access: when this provisioning entry becomes active.
   * @param grantedBy - How the access was granted: policy, request, or manual.
   */
  async updateProvisioningState(
    identityId: string,
    targetSystem: string,
    status: ProvisioningState['status'],
    errorMsg?: string,
    writebackComplete?: boolean,
    options?: { expiresAt?: Date; activeFrom?: Date; grantedBy?: 'policy' | 'request' | 'manual' },
  ): Promise<IdentityDocument | null> {
    const fallbackTenantId = requestContext.getStore()?.tenantId || DEFAULT_TENANT;
    const identity = await saveWithRetry(
      () => this.identityModel.findById(identityId).exec(),
      (doc) => {
        ensureTenantId(doc, fallbackTenantId);
        let prov = doc.provisioning || [];
        const found = prov.find((p) => p.targetSystem === targetSystem);
        let entry: ProvisioningState;
        if (found) {
          entry = found;
        } else {
          entry = { targetSystem, status: 'PENDING', lastSync: undefined } as ProvisioningState;
          (entry as unknown as Record<string, unknown>).tenantId = doc.tenantId;
          prov = [...prov, entry];
        }
        if (status === 'DEPROVISIONED') {
          entry.provisionedAt = null;
          entry.writebackComplete = false;
        } else if (status === 'SYNCED' || entry.status === 'SYNCED') {
          entry.provisionedAt ??= new Date();
        } else if (entry.status === 'DEPROVISIONED') {
          // Deprovisioned before the marker existed: no account until the next SYNCED
          entry.provisionedAt = null;
        }
        entry.status = status;
        entry.errorMsg = errorMsg;
        if (writebackComplete === true) {
          entry.writebackComplete = true;
        }
        if (options?.expiresAt !== undefined) entry.expiresAt = options.expiresAt;
        if (options?.activeFrom !== undefined) entry.activeFrom = options.activeFrom;
        if (options?.grantedBy !== undefined) entry.grantedBy = options.grantedBy;
        if (status === 'SYNCED' || status === 'ERROR' || status === 'DEPROVISIONED') {
          entry.lastSync = new Date();
        }
        doc.provisioning = prov;
      },
      `updateProvisioningState(${identityId},${targetSystem})`,
      this.logger,
    );
    return identity;
  }
}
