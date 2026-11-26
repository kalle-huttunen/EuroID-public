/**
 * Orphan Detection Service
 *
 * Detects accounts in target systems that have no corresponding identity in the Hub
 * (or whose identity is TERMINATED/DELETED). Creates drift records and emits events.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { IdentityService } from '../identity/identity.service';
import { DriftService } from './drift.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { AdService } from '../connectors/ad-connector/ad.service';
import { SCIMService } from '../connectors/scim-connector/scim.service';
import { ConnectorConfigService } from '../connectors/connector-config.service';
import type { TargetAccount } from '@shared/interfaces/provisioning.interface';
import type { DriftDocument, DriftStatus } from './schemas/drift.schema';
import { loadAdConfig, loadScimConfig } from './reconciliation-target-config';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { type OrphanConfig, orphanConfig } from '@infrastructure/config/orphan.config';
import { orphanEventIdentifier } from './orphan-event-identifier';
import { OrphanCleanupService } from './orphan-cleanup.service';
import { excludedUsersOf } from '@shared/utils/reconciliation-scope';
import { normalizeEmail } from '@shared/utils/email';

export interface OrphanedAccount {
  targetSystem: string;
  externalId: string;
  accountName?: string;
  accountIdentifier: string;
  email?: string;
  displayName?: string;
  accountEnabled?: boolean;
}

export interface OrphanDetectionResult {
  /** Every orphan account the run found. */
  orphans: OrphanedAccount[];
  /**
   * The orphan drifts whose cleanup the run starts: the ones it recorded, and an open one whose
   * cleanup never started. An account with an open drift that has a cleanup, whose latest drift
   * an admin ignored, or whose cleanup still runs, is in `orphans` only.
   */
  driftRecords: DriftDocument[];
}

/** An Entra ID B2B guest's UPN carries this; a guest has no HR identity by design. */
const GUEST_UPN_MARK = '#ext#';

/** An ORPHAN_EXCLUDED_ACCOUNTS entry as a pattern: `*` is any text, the rest is literal. */
function exclusionPattern(entry: string): RegExp {
  const literal = entry
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${literal}$`, 'i');
}

/** The account's UPN and mail, each as given and in the stored email form, without repeats. */
function addressKeys(account: TargetAccount): string[] {
  const addresses = [account.userPrincipalName, account.mail].filter(
    (a): a is string => typeof a === 'string' && a.trim() !== '',
  );
  return [...new Set(addresses.flatMap((a) => [a, normalizeEmail(a)]))];
}

/** The keys an identity can hold an account by: its UPN and mail (isStillOrphan), id and GUID. */
function accountKeys(account: TargetAccount): string[] {
  return [...addressKeys(account), account.id, account.objectGuid].filter(
    (k): k is string => typeof k === 'string' && k !== '',
  );
}

/** Accounts a system lists at once are worked through in pages of this many. */
const ORPHAN_PAGE_SIZE = 500;

/** An orphan drift in one of these is the account's open record. */
const OPEN_ORPHAN_STATUSES: DriftStatus[] = ['open', 'quarantined'];

/**
 * Detects orphaned accounts: target system accounts with no active Hub identity.
 */
@Injectable()
export class OrphanDetectionService {
  private readonly logger = new Logger(OrphanDetectionService.name);

  constructor(
    private readonly identityService: IdentityService,
    private readonly driftService: DriftService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly entraService: EntraService,
    private readonly adService: AdService,
    private readonly scimService: SCIMService,
    private readonly connectorConfig: ConnectorConfigService,
    @Inject(orphanConfig.KEY) private readonly orphanConf: OrphanConfig,
    private readonly orphanCleanup: OrphanCleanupService,
  ) {}

  /**
   * Detect orphaned accounts for a target system.
   * Fetches all accounts from the system, looks up each in the Hub, flags orphans. One open
   * record per account: an account with an open orphan drift, whose latest orphan drift an admin
   * ignored, or whose cleanup still runs, gets no new drift, orphan.detected or cleanup.
   * `excludedUsers`: the reconciliation run's (identity ids or emails); an excluded user's orphan
   * account is left alone, in neither result list (isExcluded).
   * The accounts are worked through page by page (an Entra ID page as Graph answers it, else
   * ORPHAN_PAGE_SIZE): one hub query for a page's keys (findLiveOwnerKeys), then `onPage` (the
   * activity heartbeats).
   */
  async detectOrphans(
    system: string,
    tenantId: string,
    excludedUsers?: readonly string[],
    onPage?: () => void,
  ): Promise<OrphanDetectionResult> {
    return withTenantContext(tenantId, async () => {
      this.logger.log(`[OrphanDetection] Starting for system ${system}`);

      const orphans: OrphanedAccount[] = [];
      const driftRecords: DriftDocument[] = [];
      const excluded = excludedUsersOf(excludedUsers);
      let scanned = 0;

      await this.forEachAccountPage(system, async (page) => {
        const owned = await this.identityService.findLiveOwnerKeys(page.flatMap(accountKeys));
        for (const account of page) {
          await this.checkAccount(
            account,
            owned,
            excluded,
            system,
            tenantId,
            orphans,
            driftRecords,
          );
        }
        scanned += page.length;
        onPage?.();
      });

      this.logger.log(
        `[OrphanDetection] Found ${orphans.length} orphans among ${scanned} accounts in ` +
          `${system}, ${driftRecords.length} to start a cleanup for`,
      );
      return { orphans, driftRecords };
    });
  }

  /** One account of a page: recorded as an orphan (drift, orphan.detected) when it is one. */
  private async checkAccount(
    account: TargetAccount,
    owned: Set<string>,
    excluded: { ids: string[]; emails: string[] },
    system: string,
    tenantId: string,
    orphans: OrphanedAccount[],
    driftRecords: DriftDocument[],
  ): Promise<void> {
    if (!this.unowned(account, owned) || (await this.isExcluded(account, excluded))) return;
    // An AD account's id is its DN, which holds the person's name: its objectGUID instead
    const externalId = account.objectGuid ?? account.id;
    orphans.push({
      targetSystem: system,
      externalId,
      accountName: account.displayName,
      accountIdentifier: account.userPrincipalName || account.mail || account.id,
      email: account.mail || account.userPrincipalName,
      displayName: account.displayName,
      accountEnabled: account.accountEnabled,
    });

    const recorded = await this.driftService.findOrphanDrifts(system, externalId);
    const open = recorded.filter((d) => OPEN_ORPHAN_STATUSES.includes(d.status));
    if (open.length > 0) {
      // A cleanup that never started (the run or the detection attempt that recorded the
      // drift stopped first) is started by this run; nothing new is recorded
      if (!open.some((d) => d.workflowId)) driftRecords.push(open[0]);
      return;
    }
    // An ignore is a decision: the account is not quarantined again (as recordDetection)
    if (recorded[recorded.length - 1]?.status === 'ignored') return;
    if (await this.cleanupStillRuns(recorded)) return;

    const drift = await this.createOrphanDrift(orphans[orphans.length - 1], tenantId);
    driftRecords.push(drift);

    // The one orphan.detected of the orphan (the cleanup workflow no longer emits it)
    this.eventEmitter.emit(DomainEventType.ORPHAN_DETECTED, externalId, {
      driftId: drift._id.toString(),
      targetSystem: system,
      externalId,
      // The opaque account id, else masked: never the UPN or mail in clear
      accountIdentifier: orphanEventIdentifier(
        externalId,
        account.userPrincipalName || account.mail,
      ),
      tenantId,
    });
  }

  /**
   * Whether the cleanup of one of the account's closed orphan drifts still runs: closing a drift
   * by hand cancels its cleanup, but one closed before that, or a cancel that failed, may not.
   */
  private async cleanupStillRuns(drifts: DriftDocument[]): Promise<boolean> {
    for (const drift of drifts) {
      if (drift.workflowId && (await this.orphanCleanup.isRunning(drift.workflowId))) return true;
    }
    return false;
  }

  /** The system's accounts, a page at a time: Entra ID's as Graph pages them, else listed once. */
  private async forEachAccountPage(
    system: string,
    handle: (page: TargetAccount[]) => Promise<void>,
  ): Promise<void> {
    if (system === 'entra-id') {
      let nextLink: string | undefined;
      do {
        const result = nextLink
          ? await this.entraService.listUsers({ nextLink })
          : await this.entraService.listUsers({ top: 999 });
        await handle(result.users);
        nextLink = result.nextLink;
      } while (nextLink);
      return;
    }
    const accounts = await this.listAccounts(system);
    for (let i = 0; i < accounts.length; i += ORPHAN_PAGE_SIZE) {
      await handle(accounts.slice(i, i + ORPHAN_PAGE_SIZE));
    }
  }

  /** The accounts of a system its connector lists in one call (AD, SCIM). */
  private async listAccounts(system: string): Promise<TargetAccount[]> {
    switch (system) {
      // An installed but incomplete config throws, naming the missing setting
      case 'ad': {
        const adConfig = await loadAdConfig(this.connectorConfig);
        if (!adConfig) {
          this.logger.warn('[OrphanDetection] AD connector not configured, skipping');
          return [];
        }
        return this.adService.listUsers(adConfig);
      }
      case 'scim': {
        const scimConfig = await loadScimConfig(this.connectorConfig);
        if (!scimConfig) {
          this.logger.warn('[OrphanDetection] SCIM connector not configured, skipping');
          return [];
        }
        return this.scimService.listUsers(scimConfig);
      }
      default:
        this.logger.warn(`[OrphanDetection] Unknown system ${system}, skipping`);
        return [];
    }
  }

  /**
   * Whether the account is an orphan detection quarantines: not a guest (`#EXT#` in its UPN) nor
   * on ORPHAN_EXCLUDED_ACCOUNTS (leftAlone), and no live identity that is not TERMINATED or
   * DELETED has it. An identity has it when its email is the account's UPN or its mail, in any
   * case (stored emails are lower-cased; an address stored in another case before that is tried
   * as given too), or when its source or id is the account's id (an AD DN, as provisioning
   * write-back links it) or objectGUID (as an adopted AD orphan is linked). The orphan cleanup
   * asks again before it disables or deletes the account.
   */
  async isStillOrphan(account: TargetAccount): Promise<boolean> {
    if (this.leftAlone(account)) return false;
    const owned = await this.identityService.findLiveOwnerKeys(accountKeys(account));
    return this.unowned(account, owned);
  }

  /**
   * Not left alone (guest, excluded) and none of the account's keys in `owned` (the keys a live
   * identity that is not TERMINATED or DELETED has: findLiveOwnerKeys).
   */
  private unowned(account: TargetAccount, owned: Set<string>): boolean {
    if (this.leftAlone(account)) return false;
    return !accountKeys(account).some((key) => owned.has(key));
  }

  /** A guest account, or one ORPHAN_EXCLUDED_ACCOUNTS names by its UPN or mail. */
  private leftAlone(account: TargetAccount): boolean {
    if (account.userPrincipalName?.toLowerCase().includes(GUEST_UPN_MARK)) return true;
    const addresses = [account.userPrincipalName, account.mail].filter(Boolean) as string[];
    return this.exclusions.some((pattern) => addresses.some((a) => pattern.test(a.trim())));
  }

  private get exclusions(): RegExp[] {
    return (this.orphanConf.excludedAccounts ?? []).map(exclusionPattern);
  }

  /**
   * Whether the run's excludedUsers name the orphan account's user: the account's UPN or mail is
   * an excluded email, or the identity it belonged to (looked up by the keys isOrphan uses; a
   * TERMINATED or DELETED one) has an excluded id or email. An offboarded (soft-deleted) identity
   * is not found, so then only the account's own UPN or mail can match.
   */
  private async isExcluded(
    account: TargetAccount,
    excluded: { ids: string[]; emails: string[] },
  ): Promise<boolean> {
    if (excluded.ids.length === 0 && excluded.emails.length === 0) return false;
    const addresses = [account.userPrincipalName, account.mail].filter(Boolean) as string[];
    if (addresses.some((a) => excluded.emails.includes(a.toLowerCase()))) return true;
    for (const key of [addresses[0], account.id, account.objectGuid]) {
      if (!key) continue;
      const owner = (await this.identityService.findUserForReconciliation(key)) as {
        _id?: unknown;
        email?: unknown;
      } | null;
      if (!owner) continue;
      if (excluded.ids.includes(String(owner._id ?? '').toLowerCase())) return true;
      if (excluded.emails.includes(String(owner.email ?? '').toLowerCase())) return true;
    }
    return false;
  }

  private async createOrphanDrift(
    orphan: OrphanedAccount,
    tenantId: string,
  ): Promise<DriftDocument> {
    const gracePeriodDays = this.orphanConf.gracePeriodDays;
    const discoveredAt = new Date();
    const gracePeriodEndsAt = new Date(discoveredAt);
    gracePeriodEndsAt.setDate(gracePeriodEndsAt.getDate() + gracePeriodDays);

    const drift = await this.driftService.saveDrift({
      tenantId,
      type: 'ORPHAN_ACCOUNT',
      severity: 'high',
      userId: orphan.externalId,
      userDisplayName: orphan.displayName ?? orphan.accountName ?? orphan.accountIdentifier,
      userEmail: orphan.email ?? orphan.accountIdentifier,
      targetSystem: orphan.targetSystem,
      status: 'quarantined',
      autoCorrectEligible: false,
      detectedAt: discoveredAt,
      orphanDetails: {
        targetSystem: orphan.targetSystem,
        externalId: orphan.externalId,
        accountName: orphan.accountName,
        discoveredAt,
        gracePeriodEndsAt,
      },
    });

    return drift;
  }
}
