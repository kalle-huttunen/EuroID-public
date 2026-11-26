/**
 * The group changes of a provisioning intent in Active Directory (provisionUserToAd), each
 * reported in Entra ID's result shape (ProvisioningOperationResult): applied, unchanged (the
 * account's direct groups already were as requested) or failed with the reason. Adds and
 * removals both run, in the intent's order, and one failure does not stop the others. Only
 * group operations reach AD: it has no licenses or directory roles, and those are left out.
 *
 * What a failed change means for the run is adChangesFailure's call (target-changes-failure.ts):
 * the AD target fails, after the other changes were made.
 */
import type { ProvisioningOperationResult } from '@shared/dtos/provisioning-result.dto';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import type { AdService } from '../modules/connectors/ad-connector/ad.service';
import type { AdConfig, ProvisioningIntent } from '../modules/connectors/ad-connector/ad.interface';
import { sameDn } from '../modules/connectors/ad-connector/ad-utils';
import { httpStatusOf } from './deprovision-failure';
import { changesFailedMessage, changesFailure } from './target-changes-failure';

type AdOperation = ProvisioningIntent['operations'][number];

/** ApplicationFailure type of a provisionUserToAd that failed on a group change. */
export const AD_CHANGES_FAILED = 'AdChangesFailed';

const SYSTEM = 'ad';

function result(
  op: AdOperation,
  outcome: ProvisioningOperationResult['outcome'],
): ProvisioningOperationResult {
  return { type: op.type, action: op.action, targetId: op.targetId, outcome };
}

/** Apply the intent's group operations to the account at `userDn`; one result per operation. */
export async function applyAdGroupChanges(
  adService: Pick<AdService, 'getUserGroupDns' | 'addUserToGroup' | 'removeGroupMember'>,
  config: AdConfig,
  userDn: string,
  intent?: ProvisioningIntent,
): Promise<ProvisioningOperationResult[]> {
  const ops = (intent?.operations ?? []).filter((op) => op.type === 'group');
  if (ops.length === 0) return [];
  const groups = await adService.getUserGroupDns(config, userDn);
  if (!groups) {
    // Provisioning has just created or found the account at this DN
    throw new ConnectorException('The AD account is not at the DN provisioning returned');
  }
  const results: ProvisioningOperationResult[] = [];
  for (const op of ops) {
    const member = groups.some((dn) => sameDn(dn, op.targetId));
    try {
      if (op.action === 'add') {
        if (!member) await adService.addUserToGroup(config, userDn, op.targetId);
        results.push(result(op, member ? 'unchanged' : 'applied'));
      } else {
        const removed =
          member && (await adService.removeGroupMember(config, userDn, op.targetId)) === 'removed';
        results.push(result(op, removed ? 'applied' : 'unchanged'));
      }
    } catch (error: unknown) {
      const status = httpStatusOf(error);
      results.push({
        ...result(op, 'failed'),
        reason: error instanceof Error ? error.message : String(error),
        ...(status === undefined ? {} : { status }),
      });
    }
  }
  return results;
}

/**
 * The error to throw for the `failed` group changes of `operations`: an LDAP error has no HTTP
 * status and is retried, a ConnectorException with a 4xx is not. The message is masked.
 */
export function adChangesFailure(
  operations: ProvisioningOperationResult[],
  failed: ProvisioningOperationResult[],
): Error {
  const message = changesFailedMessage(SYSTEM, operations.length, failed);
  return changesFailure(SYSTEM, message, failed, AD_CHANGES_FAILED);
}
