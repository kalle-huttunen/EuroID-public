/**
 * How provisionUserToEntra fails when Entra ID did not make some of the intent's group,
 * directory role or license changes. EntraProvisioningService attempted every change and
 * reported each (the ones made stay made); what that means for the run is decided here:
 * - The call created the account: not retried, whatever the reasons. A retry would not find
 *   the account (its id is not written back yet) and would create a second one. The account's
 *   id and generated attributes travel in the failure's details (EntraCreatedAccount) for the
 *   workflow to write back.
 * - Otherwise as every target's changes (target-changes-failure.ts): a failed change retrying
 *   cannot fix (a 4xx other than 408, 409 and 429: refused by Graph, a group or SKU that does
 *   not exist) fails the run without retry; a 429 waits; a 5xx or no answer is retried per
 *   CONNECTOR_RETRY, and the retry makes only what is left.
 * The message names each failed change and its reason; email addresses in it are masked.
 */
import { ApplicationFailure } from '@temporalio/common';
import type {
  ProvisioningOperationResult,
  ProvisioningResult,
} from '@shared/dtos/provisioning-result.dto';
import { ENTRA_CHANGES_FAILED, type EntraCreatedAccount } from '@shared/types/entra-provisioning';
import { changesFailedMessage, changesFailure } from './target-changes-failure';

const SYSTEM = 'entra-id';

/** The error to throw for a provision() result whose `failed` changes were not made. */
export function entraChangesFailure(
  result: ProvisioningResult,
  failed: ProvisioningOperationResult[],
): Error {
  const total = result.operations?.length ?? failed.length;
  const message = changesFailedMessage(SYSTEM, total, failed);
  // upnResolution: provision() created the account in this call
  if (result.upnResolution) {
    const created: EntraCreatedAccount = {
      objectId: result.targetUserId,
      generatedAttributes: result.generatedAttributes,
    };
    return ApplicationFailure.nonRetryable(
      `${message} The account was created; the call is not retried, which would create a second one.`,
      ENTRA_CHANGES_FAILED,
      created,
    );
  }
  return changesFailure(SYSTEM, message, failed, ENTRA_CHANGES_FAILED);
}
