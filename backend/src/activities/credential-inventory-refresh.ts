import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { catalogSystemName, getSystemType } from '@shared/utils/normalize-system-name';
import { Identity, type IdentityDocument } from '../modules/identity/schemas/identity.schema';
import { NOT_DELETED } from '../modules/identity/identity.constants';
import { targetAccountId } from '../modules/identity/identity-provisioning.service';
import { CredentialInventoryService } from '../modules/credential-lifecycle/credential-inventory.service';
import { CredentialPolicyService } from '../modules/credential-lifecycle/credential-policy.service';
import type {
  CredentialInventory,
  PasswordState,
} from '../modules/credential-lifecycle/schemas/credential-inventory.schema';
import type { CredentialPolicyDocument } from '../modules/credential-lifecycle/schemas/credential-policy.schema';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import type { AdConfig } from '../modules/connectors/ad-connector/ad.interface';
import type {
  CredentialState,
  MfaStatus,
} from '../modules/connectors/credential-management.interface';
import { ConfigActivities } from './config.activities';
import { CredentialActivities } from './credential.activities';
import { maskPersonalData } from './deprovision-failure';

const DAY_MS = 86_400_000;
/** Warning window in days when the policy has no rotation settings (the run's earlier default). */
const DEFAULT_NOTIFY_DAYS = 14;
/** The systems this refresh reads, as inventory rows name them (catalogSystemName). */
const OBSERVED_SYSTEMS = ['entra-id', 'ad'] as const;
type ObservedSystem = (typeof OBSERVED_SYSTEMS)[number];
const SYSTEM_LABEL: Record<ObservedSystem, string> = {
  'entra-id': 'Entra ID',
  ad: 'Active Directory',
};

/** One account to read: an identity's SYNCED Entra ID or AD provisioning entry. */
interface Account {
  identityId: string;
  targetSystem: ObservedSystem;
  /** The account id the target wrote back; absent when none was. */
  accountId?: string;
  employmentType?: string;
}

interface Targets {
  entraConfigured: boolean;
  adConfig: AdConfig | null;
}

type Reading = { state: CredentialState; mfa?: MfaStatus } | { reason: string };

export interface InventoryRefreshResult {
  /** Accounts read (a row written for each, UNKNOWN ones included). */
  observed: number;
  /** Of those, rows written UNKNOWN (with the reason). */
  unknown: number;
  /** Of those, rows whose password status is not what it was (a new row counts). */
  changed: number;
  /** Rows deleted: the identity no longer has that account (deprovisioned, deleted). */
  removed: number;
}

const key = (identityId: string, targetSystem: string) => `${identityId}|${targetSystem}`;
const errorText = (err: unknown) =>
  maskPersonalData(err instanceof Error ? err.message : String(err)).slice(0, 300);

/**
 * Fills credential_inventory by observation (design: "Connector credential activities (F-10)").
 * For each identity with a SYNCED Entra ID or AD provisioning entry it reads the account's
 * credential state through CredentialActivities (last password change; MFA methods for Entra ID)
 * and writes one row per identity and system. The status comes from the credential policy that
 * applies (CredentialPolicyService.resolvePolicy with the system and the identity's employment
 * type): EXPIRED once the password is older than passwordPolicy.maxAgeDays, EXPIRING_SOON within
 * rotationPolicy.notifyDaysBefore of that. An account it cannot judge gets UNKNOWN with the reason
 * (not configured, not readable, no account id, no policy, no date); none is skipped.
 *
 * At most `limit` accounts per tenant and run, the ones never read or read longest ago first: a
 * large tenant is covered over several runs and one run stays short. Rows of accounts the identity
 * no longer has are deleted. Nothing here changes a password.
 */
@Injectable()
export class CredentialInventoryRefresh {
  private readonly logger = new Logger(CredentialInventoryRefresh.name);

  constructor(
    @InjectModel(Identity.name) private readonly identityModel: Model<IdentityDocument>,
    private readonly inventory: CredentialInventoryService,
    private readonly policies: CredentialPolicyService,
    private readonly credentials: CredentialActivities,
    private readonly entra: EntraService,
    private readonly config: ConfigActivities,
  ) {}

  /** Runs inside the tenant's context (the caller's withTenantContext). */
  async refreshTenant(tenantId: string, now: Date, limit: number): Promise<InventoryRefreshResult> {
    const accounts = await this.accounts(tenantId);
    const live = new Set(accounts.map((a) => key(a.identityId, a.targetSystem)));
    const rows = await this.inventory.findObservations(tenantId);
    const readAt = new Map(
      rows.map((r) => [key(r.identityId, r.targetSystem), r.observedAt?.getTime() ?? 0]),
    );
    const statusBefore = new Map(
      rows.map((r) => [key(r.identityId, r.targetSystem), r.password?.status]),
    );
    const gone = rows.filter(
      (r) =>
        (OBSERVED_SYSTEMS as readonly string[]).includes(r.targetSystem) &&
        !live.has(key(r.identityId, r.targetSystem)),
    );
    const removed = await this.inventory.deleteByIds(
      tenantId,
      gone.map((r) => r._id),
    );

    // Never read first (0), then read longest ago; the sort is stable, so ties keep _id order.
    const due = accounts
      .map((account) => ({
        account,
        at: readAt.get(key(account.identityId, account.targetSystem)) ?? 0,
      }))
      .sort((x, y) => x.at - y.at)
      .slice(0, Math.max(0, limit))
      .map((x) => x.account);
    if (!due.length) return { observed: 0, unknown: 0, changed: 0, removed };

    const targets = await this.targets(tenantId, due);
    const policyCache = new Map<string, Promise<CredentialPolicyDocument | null>>();
    const policyFor = (a: Account) => {
      const cacheKey = key(a.targetSystem, a.employmentType ?? '');
      if (!policyCache.has(cacheKey)) {
        policyCache.set(
          cacheKey,
          this.policies.resolvePolicy(tenantId, a.targetSystem, a.employmentType),
        );
      }
      return policyCache.get(cacheKey)!;
    };

    let unknown = 0;
    let changed = 0;
    const mfaFailures: string[] = [];
    for (const account of due) {
      const reading = await this.read(tenantId, account, targets, mfaFailures);
      const row = this.judge(account, reading, await policyFor(account), now);
      await this.inventory.upsert(
        tenantId,
        account.identityId,
        account.targetSystem,
        account.accountId ?? '',
        row,
      );
      if (row.password?.status === 'UNKNOWN') unknown++;
      const before = statusBefore.get(key(account.identityId, account.targetSystem));
      if (row.password?.status !== before) changed++;
    }
    if (mfaFailures.length) {
      this.logger.warn(
        `[CredentialInventory] Entra ID MFA methods unreadable for ${mfaFailures.length} ` +
          `account(s) of tenant ${tenantId}: ${mfaFailures[0]}`,
      );
    }
    return { observed: due.length, unknown, changed, removed };
  }

  /** Every SYNCED Entra ID or AD account of the tenant's live identities, in _id order. */
  private async accounts(tenantId: string): Promise<Account[]> {
    const cursor = this.identityModel
      .find(
        { tenantId, ...NOT_DELETED, 'provisioning.status': 'SYNCED' },
        {
          'profile.employmentType': 1,
          'sources.sourceName': 1,
          'sources.externalId': 1,
          'sources.sourceRole': 1,
          'provisioning.targetSystem': 1,
          'provisioning.status': 1,
        },
      )
      .sort({ _id: 1 })
      .lean()
      .cursor();
    const accounts: Account[] = [];
    for await (const doc of cursor) {
      const seen = new Set<string>();
      for (const entry of doc.provisioning ?? []) {
        if (entry.status !== 'SYNCED' || getSystemType(entry.targetSystem) === 'unknown') continue;
        const targetSystem = catalogSystemName(entry.targetSystem) as ObservedSystem;
        if (seen.has(targetSystem)) continue;
        seen.add(targetSystem);
        accounts.push({
          identityId: String(doc._id),
          targetSystem,
          accountId: targetAccountId(doc.sources, entry.targetSystem),
          employmentType: doc.profile?.employmentType,
        });
      }
    }
    return accounts;
  }

  /** Whether Entra ID can be called and the AD config, read once per run for the systems needed. */
  private async targets(tenantId: string, due: Account[]): Promise<Targets> {
    const needs = (system: ObservedSystem) => due.some((a) => a.targetSystem === system);
    return {
      entraConfigured: needs('entra-id') ? await this.entra.isConfiguredForTenant() : false,
      adConfig: needs('ad')
        ? ((await this.config.getConnectorConfig('ad', tenantId)) as AdConfig | null)
        : null,
    };
  }

  private async read(
    tenantId: string,
    account: Account,
    targets: Targets,
    mfaFailures: string[],
  ): Promise<Reading> {
    const system = SYSTEM_LABEL[account.targetSystem];
    if (!account.accountId)
      return { reason: `EuroID holds no ${system} account id for this identity` };
    const notConfigured = { reason: `${system} is not configured for this tenant` };
    try {
      if (account.targetSystem === 'entra-id') {
        if (!targets.entraConfigured) return notConfigured;
        const state = await this.credentials.getEntraCredentialState(account.accountId, tenantId);
        let mfa: MfaStatus | undefined;
        try {
          mfa =
            (await this.credentials.getEntraMfaStatus(account.accountId, tenantId)) ?? undefined;
        } catch (err: unknown) {
          // The password state stands; the row keeps the MFA state it had.
          mfaFailures.push(errorText(err));
        }
        return { state, mfa };
      }
      if (!targets.adConfig?.host) return notConfigured;
      const state = await this.credentials.getAdCredentialState(
        account.accountId,
        targets.adConfig,
        tenantId,
      );
      return state ? { state } : notConfigured;
    } catch (err: unknown) {
      return { reason: `${system} could not read the account: ${errorText(err)}` };
    }
  }

  /** The row for an account: its password status under the policy, or UNKNOWN with the reason. */
  private judge(
    account: Account,
    reading: Reading,
    policy: CredentialPolicyDocument | null,
    now: Date,
  ): Partial<CredentialInventory> {
    const unknown = (statusReason: string, lastRotated?: Date): Partial<CredentialInventory> => ({
      observedAt: now,
      password: { status: 'UNKNOWN', statusReason, ...(lastRotated ? { lastRotated } : {}) },
    });
    if ('reason' in reading) return unknown(reading.reason);
    const system = SYSTEM_LABEL[account.targetSystem];
    const lastSet = reading.state.passwordLastSet
      ? new Date(reading.state.passwordLastSet)
      : undefined;
    const mfa = reading.mfa
      ? { mfa: { enrolled: reading.mfa.enrolled, methods: reading.mfa.methods } }
      : {};
    const withMfa = (row: Partial<CredentialInventory>) => ({ ...row, ...mfa });

    if (!policy)
      return withMfa(unknown(`No active credential policy applies to ${system}`, lastSet));
    const maxAgeDays = policy.passwordPolicy?.maxAgeDays;
    if (!maxAgeDays) {
      return withMfa(unknown(`Policy "${policy.name}" sets no maximum password age`, lastSet));
    }
    if (!lastSet)
      return withMfa(unknown(`${system} reports no password change date for this account`));

    const nextRotation = new Date(lastSet.getTime() + maxAgeDays * DAY_MS);
    const warnDays = policy.rotationPolicy?.notifyDaysBefore ?? DEFAULT_NOTIFY_DAYS;
    let status: PasswordState['status'] = 'COMPLIANT';
    if (nextRotation.getTime() <= now.getTime()) status = 'EXPIRED';
    else if (nextRotation.getTime() <= now.getTime() + warnDays * DAY_MS) status = 'EXPIRING_SOON';
    return withMfa({ observedAt: now, password: { status, lastRotated: lastSet, nextRotation } });
  }
}
