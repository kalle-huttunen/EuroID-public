/**
 * Removes the access of one expired provisioning entry for entitlementExpiryWorkflow through the
 * per-target deprovision activity offboarding uses (offboarding-deprovision.ts): Entra ID deletes
 * the user, AD disables the account, SCIM, Okta, GitHub and ServiceNow run their connector's
 * deprovision. The expiry check is itself one activity, so it calls those activity classes
 * directly instead of scheduling them. Outcomes follow offboarding:
 * - an account the target no longer has is already gone and counts as removed;
 * - a target that keeps no account (Discord webhook, Google Sheets, File outbound) has nothing
 *   to remove;
 * - a target with no deprovision, a missing canvas config and AD without a distinguished name
 *   are failures that say a person must remove the access;
 * - a failed activity's error (masked, retryable or not as in offboarding) is the failure.
 * The account id is the identity's account record for the target, as offboarding reads it.
 */
import { Injectable } from '@nestjs/common';
import type {
  IdentityDocument,
  ProvisioningState,
} from '../modules/identity/schemas/identity.schema';
import { IdentityProvisioningService } from '../modules/identity/identity-provisioning.service';
import { BlueprintsService } from '../modules/blueprints/blueprints.service';
import type { EntraConfig } from '../modules/connectors/entra-connector/entra.interface';
import type { AdConfig } from '../modules/connectors/ad-connector/ad.interface';
import type { SCIMConnectorConfig } from '../modules/connectors/scim-connector/scim.interface';
import { getRequestContext } from '../infrastructure/middleware/get-request-context';
import type { DeprovisionResult } from '../shared/types/deprovision';
import {
  offboardingTargetKind,
  type OffboardingTargetKind,
} from '../workflows/offboarding-targets';
import { EntraActivities } from './entra.activities';
import { AdActivities } from './ad.activities';
import { ScimActivities } from './scim.activities';
import { OktaActivities } from './okta.activities';
import { GitHubActivities } from './github.activities';
import { ServiceNowActivities } from './servicenow.activities';
import {
  type DeprovisionOutcome,
  failedWith,
  notDeprovisionable,
} from './entitlement-expiry-failure';

type AccountKind = Exclude<OffboardingTargetKind, 'not-applicable' | 'unknown'>;

/** Canvas connector whose config the activity takes as an argument (the others read their own). */
const CANVAS_CONNECTOR: Partial<Record<AccountKind, string>> = {
  entra: 'entra-id',
  ad: 'ad',
  scim: 'scim',
};

interface Account {
  identityId: string;
  email: string;
  /** The account's id in the target (account record), if any. */
  externalId?: string;
  config: Record<string, unknown> | null;
  tenantId: string;
  correlationId?: string;
}

@Injectable()
export class EntitlementExpiryDeprovision {
  constructor(
    private readonly provisioningService: IdentityProvisioningService,
    private readonly blueprintsService: BlueprintsService,
    private readonly entra: EntraActivities,
    private readonly ad: AdActivities,
    private readonly scim: ScimActivities,
    private readonly okta: OktaActivities,
    private readonly github: GitHubActivities,
    private readonly serviceNow: ServiceNowActivities,
  ) {}

  async deprovision(
    identity: IdentityDocument,
    entry: ProvisioningState,
    tenantId: string,
  ): Promise<DeprovisionOutcome> {
    const system = entry.targetSystem;
    const kind = offboardingTargetKind(system);
    if (kind === 'not-applicable') {
      return { deprovisioned: true, outcome: 'not-applicable', detail: 'keeps no account' };
    }
    if (kind === 'unknown') {
      return notDeprovisionable(
        `${system}: expiry has no deprovision for this target. Remove the access there by hand ` +
          'and mark it removed manually',
      );
    }
    const connector = CANVAS_CONNECTOR[kind];
    const config = connector ? await this.getConnectorConfig(connector) : null;
    if (connector && !config) {
      return notDeprovisionable(`${system}: no connector config on the canvas`);
    }

    const externalId = this.provisioningService.accountIdFor(identity, system);
    if (kind === 'ad' && !externalId) {
      return notDeprovisionable(
        `${system}: no AD distinguished name recorded for the account. Disable it in Active ` +
          'Directory by hand and mark it removed manually',
      );
    }
    const account: Account = {
      identityId: identity._id.toString(),
      email: identity.profile?.email ?? '',
      externalId,
      config,
      tenantId,
      correlationId: getRequestContext()?.correlationId,
    };
    try {
      const { outcome, detail } = await this.removeAccount(kind, account);
      return { deprovisioned: true, outcome, detail };
    } catch (err: unknown) {
      return failedWith(err);
    }
  }

  /** The offboarding deprovision activity of `kind`, with offboarding's arguments. */
  private async removeAccount(kind: AccountKind, a: Account): Promise<DeprovisionResult> {
    switch (kind) {
      case 'entra': {
        // The stored object id, else the email as UPN; without a stored id the activity also
        // looks the user up by mail before saying gone (offboarding's byEmail)
        const { outcome } = await this.entra.deleteUser(
          a.externalId ?? a.email,
          a.config as unknown as EntraConfig,
          a.identityId,
          a.tenantId,
          a.correlationId,
          a.externalId === undefined,
        );
        return { outcome, detail: outcome === 'deprovisioned' ? 'deleted' : 'no such user' };
      }
      case 'ad':
        return this.ad.deprovisionAdUser(
          a.externalId as string,
          a.config as unknown as AdConfig,
          a.tenantId,
          a.correlationId,
          a.identityId,
        );
      case 'scim': {
        const { outcome, detail } = await this.scim.deprovisionScimUser(
          a.config as unknown as SCIMConnectorConfig,
          a.externalId,
          a.tenantId,
          a.correlationId,
          a.email,
          a.identityId,
        );
        return { outcome, detail };
      }
      case 'okta':
        return this.okta.deprovisionOktaUser(
          a.externalId,
          a.email,
          a.tenantId,
          a.correlationId,
          a.identityId,
        );
      case 'github':
        return this.github.deprovisionGitHubUser(
          a.email,
          a.tenantId,
          a.correlationId,
          a.externalId,
          a.identityId,
        );
      case 'servicenow':
        return this.serviceNow.deprovisionServiceNowUser(
          a.externalId,
          a.email,
          a.tenantId,
          a.correlationId,
          a.identityId,
        );
    }
  }

  /** The config of the canvas node for `connectorId` (latest blueprint), or null. */
  private async getConnectorConfig(connectorId: string): Promise<Record<string, unknown> | null> {
    const blueprint = await this.blueprintsService.getLatestBlueprint();
    if (!blueprint) return null;
    const connectorNode = blueprint.nodes.find((node: Record<string, unknown>) => {
      const data = node.data as Record<string, unknown> | undefined;
      const nodeId = node.id as string | undefined;
      return (
        nodeId === connectorId ||
        data?.type === connectorId ||
        nodeId?.toLowerCase?.().includes(connectorId.toLowerCase()) ||
        (data?.type as string | undefined)?.toLowerCase?.().includes(connectorId.toLowerCase())
      );
    });
    const data = connectorNode?.data as Record<string, unknown> | undefined;
    return (data?.config as Record<string, unknown>) ?? null;
  }
}
