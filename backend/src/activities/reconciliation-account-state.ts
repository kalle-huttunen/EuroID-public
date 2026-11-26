/**
 * What reconciliation compares between a hub identity and its account in a target system, and
 * how it sets an account's enabled state (ReconciliationActivities, OrphanActivities).
 *
 * The account lookups (EntraService, AdService and SCIMService getUserByEmail) return the
 * account's id, UPN, mail, display name (not AD's) and enabled state. Only those are compared:
 * a field the lookup does not return would read as "the target has none" for every user.
 * - The enabled state against the one provisioning writes for the hub status
 *   (targetAccountEnabled, the rule the Entra ID, AD and SCIM mappers use): enabled for ACTIVE
 *   and PENDING, disabled for every other status, and a linked admin account only during its
 *   session. A STATUS_MISMATCH is CRITICAL either way. Disabling an account the hub status says
 *   should be disabled is containment and may be auto-corrected; enabling grants access and is
 *   left to a person.
 * - The display name, when the hub record has one (provisioning writes it then) and the target
 *   reports one. Only Entra ID can correct a field (re-provisioning), so only there is the drift
 *   auto-correctable.
 * The email is not compared: the account was found by it (mail or UPN).
 */
import {
  DriftType,
  type SystemDrift,
  type UserSnapshot,
} from '@shared/dtos/distributed-transaction.dto';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { targetAccountEnabled } from '@shared/utils/linked-admin-profile';
import type { EntraActivities } from './entra.activities';
import type { AdService } from '../modules/connectors/ad-connector/ad.service';
import type { SCIMService } from '../modules/connectors/scim-connector/scim.service';
import type { ConnectorConfigService } from '../modules/connectors/connector-config.service';
import {
  loadAdConfig,
  loadScimConfig,
} from '../modules/reconciliation/reconciliation-target-config';

/** The value a STATUS_MISMATCH drift stores for an enabled state. */
const stateName = (enabled: boolean): 'ENABLED' | 'DISABLED' => (enabled ? 'ENABLED' : 'DISABLED');

/** The drifts between the hub identity and its account in `system`. */
export function compareAccountState(
  hubUser: StandardUserDto,
  snapshot: UserSnapshot,
  system: string,
): SystemDrift[] {
  const drifts: SystemDrift[] = [];
  const state = (snapshot.state ?? {}) as Record<string, unknown>;

  const hubName = typeof hubUser.displayName === 'string' ? hubUser.displayName.trim() : '';
  const targetName = typeof state.displayName === 'string' ? state.displayName.trim() : undefined;
  if (hubName && targetName !== undefined && hubName.toLowerCase() !== targetName.toLowerCase()) {
    drifts.push({
      system,
      driftType: DriftType.FIELD_MISMATCH,
      field: 'displayName',
      expectedValue: hubName,
      actualValue: targetName,
      description: `Field "displayName" differs: Hub="${hubName}" vs ${system}="${targetName}"`,
      severity: 'MEDIUM',
      autoCorrect: system === 'entra-id',
    });
  }

  if (typeof state.accountEnabled === 'boolean' && hubUser.status) {
    const expected = targetAccountEnabled(hubUser);
    if (expected !== state.accountEnabled) {
      const expectedName = stateName(expected);
      const actualName = stateName(state.accountEnabled);
      drifts.push({
        system,
        driftType: DriftType.STATUS_MISMATCH,
        field: 'status',
        expectedValue: expectedName,
        actualValue: actualName,
        description:
          `Account ${actualName} in ${system}; hub status ${String(hubUser.status)} expects ` +
          expectedName,
        severity: 'CRITICAL',
        autoCorrect: !expected,
      });
    }
  }

  return drifts;
}

export interface AccountStateDeps {
  entraActivities: Pick<EntraActivities, 'enableEntraUser' | 'disableEntraUser'>;
  adService: Pick<AdService, 'getUserByEmail' | 'setUserEnabled'>;
  scimService: Pick<SCIMService, 'setActive'>;
  connectorConfig: ConnectorConfigService;
}

/**
 * Enable or disable the account `identifier` (the email, else the UPN) names in `system`: Entra
 * ID by the UPN or mail, AD by the DN of the account found by it, SCIM by the user whose userName
 * or email it is. `success` is false, with the reason, when the target has no such account or
 * cannot be changed here; connector errors propagate.
 */
export async function setTargetAccountEnabled(
  deps: AccountStateDeps,
  system: string,
  identifier: string,
  enabled: boolean,
  tenantId?: string,
): Promise<{ success: boolean; error?: string }> {
  switch (system) {
    case 'entra-id': {
      const done = enabled
        ? await deps.entraActivities.enableEntraUser(identifier, tenantId)
        : await deps.entraActivities.disableEntraUser(identifier, tenantId);
      return done ? { success: true } : { success: false, error: 'No such account in entra-id' };
    }
    case 'ad': {
      const config = await loadAdConfig(deps.connectorConfig);
      if (!config) return { success: false, error: 'No ad connector config is installed' };
      const account = await deps.adService.getUserByEmail(config, identifier);
      if (!account) return { success: false, error: 'No such account in ad' };
      const result = await deps.adService.setUserEnabled(config, account.id, enabled);
      return result.outcome === 'done'
        ? { success: true }
        : { success: false, error: 'No such account in ad' };
    }
    case 'scim': {
      const config = await loadScimConfig(deps.connectorConfig);
      if (!config) return { success: false, error: 'No scim connector config is installed' };
      const result = await deps.scimService.setActive(
        config,
        { userNames: [identifier], emails: [identifier] },
        enabled,
      );
      return result.outcome === 'done'
        ? { success: true }
        : { success: false, error: 'No such account in scim' };
    }
    default:
      return { success: false, error: `Changing account state is not supported in ${system}` };
  }
}
