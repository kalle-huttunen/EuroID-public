/**
 * An identity's group memberships in the review targets: what a campaign puts up for review
 * (gather, at activation) and how a revoked membership is removed (revoke, from the access
 * review workflow's connector activities). Entra ID, Active Directory, Okta and SCIM.
 *
 * The connector services are dumb pipes; the decisions are made here: which account is the
 * holder's, which memberships EuroID can remove, and what counts as already gone. Gathering
 * records the account it found on each entitlement (`accountId`), and revocation acts on that
 * account, so a review never removes access from an account other than the one reviewed.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import type {
  ConnectorRevocationResult,
  RevocationConnector,
} from '@shared/types/access-review-revocation';
import { ConfigActivities } from '../../activities/config.activities';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { AdService } from '../connectors/ad-connector/ad.service';
import type { AdConfig } from '../connectors/ad-connector/ad.interface';
import { OktaService } from '../connectors/okta-connector/okta.service';
import { SCIMService } from '../connectors/scim-connector/scim.service';
import type { SCIMConnectorConfig } from '../connectors/scim-connector/scim.interface';
import { maskEmail } from '../identity/identity-pii';
import type { ReviewEntitlement } from './schemas/review-item.schema';
import { REVIEW_ENTITLEMENT_TYPES as T } from './review-revocation';

/** Review targets of the tenant, read once per campaign activation. */
export interface ReviewTargets {
  /**
   * Entra ID: the tenant's installed Entra ID connector config, else the environment's app
   * registration (ENTRA_*); EntraService picks the config on each call.
   */
  entra: boolean;
  /** Canvas configs; absent when the target is not on the canvas. */
  ad?: AdConfig;
  scim?: SCIMConnectorConfig;
  /** Okta on the canvas (OktaService reads its connector config itself). */
  okta: boolean;
}

/** The identity whose access is reviewed. */
export interface ReviewHolder {
  email: string;
  userPrincipalName?: string;
  /** Account records: target account ids written back by onboarding (`sources[]`). */
  sources?: Array<{ sourceName?: string; externalId?: string }>;
}

/** The fields of a review entitlement revocation reads. */
export type RevocableEntitlement = Pick<ReviewEntitlement, 'nativeId' | 'accountId'>;

const ENTRA_GROUP = '#microsoft.graph.group';
const ENTRA_TYPES: Record<string, string> = {
  [ENTRA_GROUP]: T.group,
  '#microsoft.graph.directoryRole': T.entraDirectoryRole,
  '#microsoft.graph.administrativeUnit': T.entraAdministrativeUnit,
};
const OKTA_GROUP = 'OKTA_GROUP';

const ACCOUNT_SOURCE_NAMES: Record<RevocationConnector, string[]> = {
  entra: ['entra-id', 'entra'],
  ad: ['ad', 'active-directory'],
  okta: ['okta'],
  scim: ['scim'],
};

/** The holder's written-back account id in the target (exact source name, never a substring). */
function storedAccountId(holder: ReviewHolder, connector: RevocationConnector): string | undefined {
  const names = ACCOUNT_SOURCE_NAMES[connector];
  const source = (holder.sources ?? []).find(
    (s) => !!s.externalId && names.includes(String(s.sourceName ?? '').toLowerCase()),
  );
  return source?.externalId;
}

/** "CN=Sales Team,OU=Groups,DC=corp" -> "Sales Team" (first RDN value, escapes removed). */
export function firstRdnValue(dn: string): string {
  const match = /^[^=]+=((?:\\.|[^,\\])+)/.exec(dn);
  return match ? match[1].replace(/\\(.)/g, '$1') : dn;
}

function sameDn(a: string, b: string): boolean {
  const norm = (dn: string) =>
    dn
      .trim()
      .toLowerCase()
      .replace(/\s*,\s*/g, ',');
  return norm(a) === norm(b);
}

function notFound(message: string): ConnectorException {
  return new ConnectorException(message, HttpStatus.UNPROCESSABLE_ENTITY);
}

const REMOVED: ConnectorRevocationResult = { outcome: 'removed', detail: 'removed from group' };
const NOT_MEMBER: ConnectorRevocationResult = {
  outcome: 'already-gone',
  detail: 'not a member any more',
};

@Injectable()
export class ReviewTargetAccessService {
  private readonly logger = new Logger(ReviewTargetAccessService.name);

  constructor(
    private readonly configActivities: ConfigActivities,
    private readonly entraService: EntraService,
    private readonly adService: AdService,
    private readonly oktaService: OktaService,
    private readonly scimService: SCIMService,
  ) {}

  async loadTargets(tenantId: string): Promise<ReviewTargets> {
    const active = await this.configActivities.getActiveTargetSystems(tenantId);
    const ad = active.includes('ad') ? await this.canvasConfig('ad', tenantId) : null;
    const scim = active.includes('scim') ? await this.canvasConfig('scim', tenantId) : null;
    return {
      entra: await this.entraService.isConfiguredForTenant(),
      ...(ad?.host ? { ad: ad as unknown as AdConfig } : {}),
      ...(scim?.baseUrl ? { scim: scim as unknown as SCIMConnectorConfig } : {}),
      okta: active.includes('okta'),
    };
  }

  /**
   * The holder's group memberships in every configured target, each with the account it was
   * found on. A target that fails is skipped with a warning (as Entra ID always was), so one
   * unreachable target does not block the campaign.
   */
  async gather(holder: ReviewHolder, targets: ReviewTargets): Promise<ReviewEntitlement[]> {
    const steps: Array<[string, () => Promise<ReviewEntitlement[]>]> = [];
    if (targets.entra) steps.push(['Entra ID', () => this.gatherEntra(holder)]);
    if (targets.ad) steps.push(['AD', () => this.gatherAd(holder, targets.ad!)]);
    if (targets.okta) steps.push(['Okta', () => this.gatherOkta(holder)]);
    if (targets.scim) steps.push(['SCIM', () => this.gatherScim(holder, targets.scim!)]);
    const entitlements: ReviewEntitlement[] = [];
    for (const [name, step] of steps) {
      try {
        entitlements.push(...(await step()));
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn(
          `[AccessReview] Could not gather ${name} access for ${maskEmail(holder.email)}: ${message}`,
        );
      }
    }
    return entitlements;
  }

  /**
   * Remove one revoked group membership. Throws when it cannot (the activity turns that into
   * a retried or a final failure); a lookup miss is a failure an admin must check, never
   * "already gone".
   */
  async revoke(
    connector: RevocationConnector,
    entitlement: RevocableEntitlement,
    holder: ReviewHolder,
    tenantId: string,
  ): Promise<ConnectorRevocationResult> {
    const groupId = entitlement.nativeId;
    if (!groupId) throw new ConnectorException('The review entitlement has no group id');
    switch (connector) {
      case 'entra':
        return this.revokeEntra(groupId, entitlement.accountId, holder);
      case 'ad':
        return this.revokeAd(groupId, entitlement.accountId, holder, tenantId);
      case 'okta':
        return this.revokeOkta(groupId, entitlement.accountId);
      case 'scim':
        return this.revokeScim(groupId, entitlement.accountId, tenantId);
    }
  }

  // --- Entra ID ---

  private async entraAccountId(holder: ReviewHolder): Promise<string | null> {
    return (
      storedAccountId(holder, 'entra') ??
      (await this.entraService.checkUserExists(holder.email)) ??
      (await this.entraService.getUserByEmail(holder.email))?.id ??
      null
    );
  }

  private async gatherEntra(holder: ReviewHolder): Promise<ReviewEntitlement[]> {
    const accountId = await this.entraAccountId(holder);
    if (!accountId) return [];
    const memberships = await this.entraService.listUserMemberships(accountId);
    return memberships.map((m) => ({
      system: 'entra-id',
      // Graph names the kind of each membership; one without @odata.type is read as a group
      type: m.odataType ? (ENTRA_TYPES[m.odataType] ?? 'other') : T.group,
      name: m.displayName || m.id,
      nativeId: m.id,
      accountId,
      policyManaged: false,
    }));
  }

  private async revokeEntra(
    groupId: string,
    accountId: string | undefined,
    holder: ReviewHolder,
  ): Promise<ConnectorRevocationResult> {
    if (!(await this.entraService.isConfiguredForTenant())) {
      throw new ConnectorException(
        'Entra ID is not configured: install the Entra ID connector, or set ENTRA_TENANT_ID, ' +
          'ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET',
      );
    }
    // Items generated before accountId was recorded: the account gathering used, by email
    const userId = accountId ?? (await this.entraAccountId({ email: holder.email }));
    if (!userId) {
      throw notFound(
        'No Entra ID user has the email as userPrincipalName or mail, and the review item ' +
          'recorded no account: check Entra ID and remove the membership there.',
      );
    }
    const membership = (await this.entraService.listUserMemberships(userId)).find(
      (m) => m.id === groupId,
    );
    if (!membership) return NOT_MEMBER;
    if (membership.odataType && membership.odataType !== ENTRA_GROUP) {
      return {
        outcome: 'manual-action-needed',
        reason:
          'This Entra ID membership is not a group (a directory role or administrative unit): ' +
          'EuroID removes only group memberships. Remove it in Entra ID.',
      };
    }
    return (await this.entraService.removeGroupMember(userId, groupId)) === 'removed'
      ? REMOVED
      : NOT_MEMBER;
  }

  // --- Active Directory ---

  /** The DN of the holder's AD account and its direct groups: stored DN, else mail/UPN. */
  private async adAccount(
    holder: ReviewHolder,
    config: AdConfig,
    storedDn: string | undefined,
  ): Promise<{ dn: string; groups: string[] } | null> {
    if (storedDn) {
      const groups = await this.adService.getUserGroupDns(config, storedDn);
      if (groups) return { dn: storedDn, groups };
    }
    const found = await this.adService.getUserByEmail(config, holder.email);
    if (!found?.id) return null;
    const groups = await this.adService.getUserGroupDns(config, found.id);
    return groups ? { dn: found.id, groups } : null;
  }

  private async gatherAd(holder: ReviewHolder, config: AdConfig): Promise<ReviewEntitlement[]> {
    const account = await this.adAccount(holder, config, storedAccountId(holder, 'ad'));
    if (!account) return [];
    return account.groups.map((groupDn) => ({
      system: 'ad',
      type: T.group,
      name: firstRdnValue(groupDn),
      nativeId: groupDn,
      accountId: account.dn,
      policyManaged: false,
    }));
  }

  private async revokeAd(
    groupDn: string,
    accountDn: string | undefined,
    holder: ReviewHolder,
    tenantId: string,
  ): Promise<ConnectorRevocationResult> {
    const config = (await this.canvasConfig('ad', tenantId)) as unknown as AdConfig | null;
    if (!config?.host) throw new ConnectorException('AD connector config not found on the canvas');
    if (!accountDn) throw notFound('The review item recorded no AD account');
    // The DN recorded at review time, or the account's DN now (moved or renamed since)
    const account = await this.adAccount(holder, config, accountDn);
    if (!account) {
      throw notFound(
        'The AD account recorded at review time no longer exists at its DN, and no AD account ' +
          "has the identity's email: check AD and remove the membership there if the account " +
          'still exists.',
      );
    }
    if (!account.groups.some((dn) => sameDn(dn, groupDn))) return NOT_MEMBER;
    return (await this.adService.removeGroupMember(config, account.dn, groupDn)) === 'removed'
      ? REMOVED
      : NOT_MEMBER;
  }

  // --- Okta ---

  private async gatherOkta(holder: ReviewHolder): Promise<ReviewEntitlement[]> {
    const stored = storedAccountId(holder, 'okta');
    let accountId = stored;
    let groups = stored ? await this.oktaService.listUserGroups(stored) : null;
    if (!groups) {
      // No stored id, or Okta no longer knows it: provisioning sets login = email
      accountId = (await this.oktaService.findUserIdByLogin(holder.email)) ?? undefined;
      groups = accountId ? await this.oktaService.listUserGroups(accountId) : null;
    }
    if (!accountId || !groups) return [];
    return groups
      .filter((g) => g.type !== 'BUILT_IN') // "Everyone": every user is a member
      .map((g) => ({
        system: 'okta',
        type:
          !g.type || g.type === OKTA_GROUP
            ? T.group
            : g.type === 'APP_GROUP'
              ? T.oktaAppGroup
              : T.oktaOtherGroup,
        name: g.profile?.name || g.id,
        nativeId: g.id,
        accountId,
        policyManaged: false,
      }));
  }

  private async revokeOkta(
    groupId: string,
    oktaUserId: string | undefined,
  ): Promise<ConnectorRevocationResult> {
    if (!oktaUserId) throw notFound('The review item recorded no Okta account');
    const groups = await this.oktaService.listUserGroups(oktaUserId);
    // Okta ids never change: Okta not knowing the reviewed user means the account is deleted
    if (!groups) return { outcome: 'already-gone', detail: 'no such Okta user any more' };
    const group = groups.find((g) => g.id === groupId);
    if (!group) return NOT_MEMBER;
    if (group.type && group.type !== OKTA_GROUP) {
      return {
        outcome: 'manual-action-needed',
        reason:
          `Okta group of type ${group.type}: Okta lets only OKTA_GROUP members be removed ` +
          'through the Groups API. Remove the membership where the group is managed.',
      };
    }
    await this.oktaService.removeGroupMember(groupId, oktaUserId);
    return REMOVED;
  }

  // --- SCIM ---

  private async gatherScim(
    holder: ReviewHolder,
    config: SCIMConnectorConfig,
  ): Promise<ReviewEntitlement[]> {
    const stored = storedAccountId(holder, 'scim');
    let accountId = stored;
    let groups = stored ? await this.scimService.getUserGroups(config, stored) : null;
    if (groups === null) {
      // No stored id, or the target no longer knows it: the identifiers provisioning used
      accountId =
        (await this.scimService.findUserIdByIdentifiers(config, {
          userNames: [holder.userPrincipalName, holder.email].filter((v): v is string => !!v),
          emails: [holder.email],
        })) ?? undefined;
      groups = accountId ? await this.scimService.getUserGroups(config, accountId) : null;
    }
    if (!accountId || !groups) return [];
    return groups.map((g) => ({
      system: 'scim',
      type: g.type === 'indirect' ? T.scimIndirectGroup : T.group,
      name: g.display || g.value,
      nativeId: g.value,
      accountId,
      policyManaged: false,
    }));
  }

  private async revokeScim(
    groupId: string,
    scimUserId: string | undefined,
    tenantId: string,
  ): Promise<ConnectorRevocationResult> {
    const config = (await this.canvasConfig(
      'scim',
      tenantId,
    )) as unknown as SCIMConnectorConfig | null;
    if (!config?.baseUrl) {
      throw new ConnectorException('SCIM connector config not found on the canvas');
    }
    if (!scimUserId) throw notFound('The review item recorded no SCIM account');
    const groups = await this.scimService.getUserGroups(config, scimUserId);
    if (groups === null) return { outcome: 'already-gone', detail: 'no such SCIM user any more' };
    if (groups) {
      // The target returns memberships on the user: check before removing
      const membership = groups.find((g) => g.value === groupId);
      if (!membership) return NOT_MEMBER;
      if (membership.type === 'indirect') {
        return {
          outcome: 'manual-action-needed',
          reason:
            'Nested membership: the user is in this group through another group. Remove the ' +
            'user from the group that grants it, in the target system.',
        };
      }
    }
    return (await this.scimService.removeGroupMember(config, groupId, scimUserId)) === 'removed'
      ? REMOVED
      : NOT_MEMBER;
  }

  private async canvasConfig(
    connectorId: 'ad' | 'scim',
    tenantId: string,
  ): Promise<Record<string, unknown> | null> {
    return this.configActivities.getConnectorConfig(connectorId, tenantId);
  }
}
