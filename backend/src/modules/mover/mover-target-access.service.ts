/**
 * The mover's change in one target system: the entitlements an identity gains and loses when it
 * moves (mover workflow, applyMoverAccess on the connector's queue).
 *
 * - Entra ID: the provisioning path the mover always used (the account's attributes updated,
 *   then the intent: groups, directory roles and licenses added and removed), with the
 *   identity's policy profile read here instead of passed through workflow history, on the
 *   account of its written-back object id, else the account with the profile's UPN, email or
 *   employee id; never a new account. A change Entra ID does not make fails the system, after
 *   the others were made.
 * - Active Directory, Okta, SCIM: group memberships of the identity's account, added and removed.
 *
 * The connector services are dumb pipes; the decisions are made here: which account is the
 * identity's (its account record written back by onboarding, else the identifiers provisioning
 * used), what is already as the policies want it, and which memberships EuroID cannot change.
 * An account that cannot be found is a failure an admin must check (422, not retried), never
 * "nothing to do".
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { normalizeSystemName } from '@shared/utils/normalize-system-name';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { MoverAccessOperation, MoverAccessResult, MoverConnector } from '@shared/types/mover';
import { ConfigActivities } from '../../activities/config.activities';
import { EntraActivities } from '../../activities/entra.activities';
import { AdService } from '../connectors/ad-connector/ad.service';
import type { AdConfig } from '../connectors/ad-connector/ad.interface';
import { sameDn } from '../connectors/ad-connector/ad-utils';
import type {
  EntraConfig,
  ProvisioningIntent,
} from '../connectors/entra-connector/entra.interface';
import { OktaService } from '../connectors/okta-connector/okta.service';
import { SCIMService } from '../connectors/scim-connector/scim.service';
import type { SCIMConnectorConfig } from '../connectors/scim-connector/scim.interface';
import { IdentityService } from '../identity/identity.service';
import type { IdentityDocument } from '../identity/schemas/identity.schema';

/** Source names of the account records onboarding writes back, per connector (normalised). */
const ACCOUNT_SOURCE_NAMES: Record<MoverConnector, string[]> = {
  entra: ['entra', 'entraid'],
  ad: ['ad', 'activedirectory'],
  okta: ['okta'],
  scim: ['scim'],
};

const OKTA_GROUP = 'OKTA_GROUP';

/** The identity's account id in the target: the externalId of its target account record. */
function storedAccountId(identity: IdentityDocument, connector: MoverConnector) {
  const names = ACCOUNT_SOURCE_NAMES[connector];
  return (identity.sources ?? []).find(
    (s) =>
      s.sourceRole === 'target' &&
      !!s.externalId &&
      names.includes(normalizeSystemName(s.sourceName)),
  )?.externalId;
}

function noAccount(system: string): ConnectorException {
  return new ConnectorException(
    `No ${system} account found for the identity: no account id is recorded (or it no longer ` +
      'exists) and no account has the identifiers EuroID provisioned with. Check the account ' +
      'in the target; the access change was not applied there.',
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

const tally = (results: boolean[]): MoverAccessResult => ({
  changed: results.filter(Boolean).length,
  unchanged: results.filter((r) => !r).length,
});

@Injectable()
export class MoverTargetAccessService {
  constructor(
    private readonly identityService: IdentityService,
    private readonly configActivities: ConfigActivities,
    private readonly entraActivities: EntraActivities,
    private readonly adService: AdService,
    private readonly oktaService: OktaService,
    private readonly scimService: SCIMService,
  ) {}

  /**
   * Apply the operations (removals first, then additions) for the identity in the connector's
   * target. Throws when a change cannot be made; the activity turns that into a retried or a
   * final failure. Only group operations reach AD, Okta and SCIM (MOVER_OPERATION_TYPES).
   */
  async apply(
    connector: MoverConnector,
    identity: IdentityDocument,
    operations: MoverAccessOperation[],
    tenantId: string,
    correlationId?: string,
  ): Promise<MoverAccessResult> {
    switch (connector) {
      case 'entra':
        return this.applyEntra(identity, operations, tenantId, correlationId);
      case 'ad':
        return this.applyAd(identity, operations, tenantId);
      case 'okta':
        return this.applyOkta(identity, operations);
      case 'scim':
        return this.applyScim(identity, operations, tenantId);
    }
  }

  // --- Entra ID ---

  private async applyEntra(
    identity: IdentityDocument,
    operations: MoverAccessOperation[],
    tenantId: string,
    correlationId?: string,
  ): Promise<MoverAccessResult> {
    // With the identity's id: Entra ID's provisioning events go under it (identity timeline)
    const profile = {
      ...(await this.identityService.buildProfileWithContractsForPolicy(identity)),
      _id: String(identity._id),
    } as unknown as StandardUserDto;
    const config = await this.configActivities.getConnectorConfig('entra-id', tenantId);
    // Throws when a change was not made (the others are made): the activity classifies it.
    // The written-back object id names the account: one Entra ID no longer has fails (422),
    // it never makes the provisioning path create a second account. Without one, the mover
    // runs only where the identity has an account (provisionedSystems), so it must exist: found
    // by the profile's UPN, email or employee id, never created (422 when none has them).
    const result = await this.entraActivities.provisionUserToEntra(
      profile,
      // Only group, role and license operations reach Entra ID (MOVER_OPERATION_TYPES)
      { operations: operations as ProvisioningIntent['operations'] },
      (config as unknown as EntraConfig) ?? undefined,
      tenantId,
      correlationId,
      storedAccountId(identity, 'entra'),
      true,
    );
    return tally((result.operations ?? []).map((op) => op.outcome === 'applied'));
  }

  // --- Active Directory ---

  private async applyAd(
    identity: IdentityDocument,
    operations: MoverAccessOperation[],
    tenantId: string,
  ): Promise<MoverAccessResult> {
    const config = (await this.configActivities.getConnectorConfig(
      'ad',
      tenantId,
    )) as unknown as AdConfig | null;
    if (!config?.host) throw new ConnectorException('AD connector config not found on the canvas');
    const account = await this.adAccount(identity, config);
    const results: boolean[] = [];
    for (const op of operations) {
      const member = account.groups.some((dn) => sameDn(dn, op.targetId));
      if (op.action === 'remove') {
        results.push(
          member &&
            (await this.adService.removeGroupMember(config, account.dn, op.targetId)) === 'removed',
        );
      } else if (member) {
        results.push(false);
      } else {
        await this.adService.addUserToGroup(config, account.dn, op.targetId);
        results.push(true);
      }
    }
    return tally(results);
  }

  /** The DN of the identity's AD account and its direct groups: stored DN, else mail/UPN. */
  private async adAccount(
    identity: IdentityDocument,
    config: AdConfig,
  ): Promise<{ dn: string; groups: string[] }> {
    const storedDn = storedAccountId(identity, 'ad');
    if (storedDn) {
      const groups = await this.adService.getUserGroupDns(config, storedDn);
      if (groups) return { dn: storedDn, groups };
    }
    const email = identity.profile?.email;
    const found = email ? await this.adService.getUserByEmail(config, email) : null;
    const groups = found?.id ? await this.adService.getUserGroupDns(config, found.id) : null;
    if (!found?.id || !groups) throw noAccount('AD');
    return { dn: found.id, groups };
  }

  // --- Okta ---

  private async applyOkta(
    identity: IdentityDocument,
    operations: MoverAccessOperation[],
  ): Promise<MoverAccessResult> {
    const stored = storedAccountId(identity, 'okta');
    let userId = stored;
    let groups = stored ? await this.oktaService.listUserGroups(stored) : null;
    const email = identity.profile?.email;
    if (!groups && email) {
      // No stored id, or Okta no longer knows it: provisioning sets login = email
      userId = (await this.oktaService.findUserIdByLogin(email)) ?? undefined;
      groups = userId ? await this.oktaService.listUserGroups(userId) : null;
    }
    if (!userId || !groups) throw noAccount('Okta');
    const results: boolean[] = [];
    for (const op of operations) {
      const group = groups.find((g) => g.id === op.targetId);
      if (op.action === 'remove') {
        if (!group) {
          results.push(false);
          continue;
        }
        if (group.type && group.type !== OKTA_GROUP) {
          throw new ConnectorException(
            `Okta group ${op.targetId} is of type ${group.type}: Okta lets only OKTA_GROUP ` +
              'members be removed through the Groups API. Remove the membership where the ' +
              'group is managed.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        await this.oktaService.removeGroupMember(op.targetId, userId);
        results.push(true);
      } else if (group) {
        results.push(false);
      } else {
        await this.oktaService.addGroupMember(op.targetId, userId);
        results.push(true);
      }
    }
    return tally(results);
  }

  // --- SCIM ---

  private async applyScim(
    identity: IdentityDocument,
    operations: MoverAccessOperation[],
    tenantId: string,
  ): Promise<MoverAccessResult> {
    const config = (await this.configActivities.getConnectorConfig(
      'scim',
      tenantId,
    )) as unknown as SCIMConnectorConfig | null;
    if (!config?.baseUrl) {
      throw new ConnectorException('SCIM connector config not found on the canvas');
    }
    const stored = storedAccountId(identity, 'scim');
    let userId = stored;
    let groups = stored ? await this.scimService.getUserGroups(config, stored) : null;
    const email = identity.profile?.email;
    if (groups === null) {
      // No stored id, or the target no longer knows it: the identifiers provisioning used
      const upn = identity.profile?.userPrincipalName;
      userId =
        (await this.scimService.findUserIdByIdentifiers(config, {
          userNames: [upn, email].filter((v): v is string => !!v),
          emails: email ? [email] : [],
        })) ?? undefined;
      groups = userId ? await this.scimService.getUserGroups(config, userId) : null;
    }
    if (!userId || groups === null) throw noAccount('SCIM');
    const results: boolean[] = [];
    for (const op of operations) {
      // `groups` undefined: the target does not return memberships on the user; ask the group
      const member = groups?.find((g) => g.value === op.targetId);
      if (op.action === 'remove') {
        if (groups && !member) {
          results.push(false);
          continue;
        }
        if (member?.type === 'indirect') {
          throw new ConnectorException(
            `Nested membership in SCIM group ${op.targetId}: the user is in it through another ` +
              'group. Remove the user from the group that grants it, in the target system.',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        results.push(
          (await this.scimService.removeGroupMember(config, op.targetId, userId)) === 'removed',
        );
      } else if (member) {
        results.push(false); // a nested membership grants the group too
      } else {
        results.push(
          (await this.scimService.addGroupMember(config, op.targetId, userId)) === 'added',
        );
      }
    }
    return tally(results);
  }
}
