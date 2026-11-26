/**
 * How a provision activity fails when the target did not make some of the intent's changes
 * (Entra ID groups, directory roles and licenses; AD groups). The connector or the activity
 * attempted every change and reported each (ProvisioningOperationResult); the ones made stay
 * made. What retrying can fix decides the failure:
 * - A failed change with a 4xx other than 408, 409 and 429 (offboarding's isRetryableStatus: a
 *   refused change, a group that does not exist, a config error): not retried.
 * - Else a 429: RateLimitedException, retried after the rate-limit wait.
 * - Else (a 5xx, no answer, an LDAP error without an HTTP status): retried per CONNECTOR_RETRY.
 *   The changes are idempotent, so a retry makes only what is left.
 * The message names each failed change and its reason, with personal data masked: it reaches
 * workflow history, the provisioning entry and the timeline.
 */
import { HttpStatus } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import type { ProvisioningOperationResult } from '@shared/dtos/provisioning-result.dto';
import {
  DEFAULT_RATE_LIMIT_MS,
  isRetryableStatus,
  maskEmails,
  maskPersonalData,
} from './deprovision-failure';

/**
 * `<system>: <n> of <total> changes failed (<change>: <reason>; ...). ...`. Reasons are masked
 * (emails, the names in DNs: an LDAP error names the user's DN); a group's id keeps its name
 * (an AD group DN), only an email in it is masked.
 */
export function changesFailedMessage(
  system: string,
  total: number,
  failed: ProvisioningOperationResult[],
): string {
  const changes = failed
    .map(
      (op) =>
        `${op.action} ${op.type} ${maskEmails(op.targetId)}: ` +
        maskPersonalData(op.reason ?? 'not made'),
    )
    .join('; ');
  return (
    `${system}: ${failed.length} of ${total} changes failed (${changes}). The other changes ` +
    'were made or were already as requested.'
  );
}

/** The error to throw with `message` for the `failed` changes; `type` names a final failure. */
export function changesFailure(
  system: string,
  message: string,
  failed: ProvisioningOperationResult[],
  type: string,
): Error {
  if (failed.some((op) => !isRetryableStatus(op.status))) {
    return ApplicationFailure.nonRetryable(message, type);
  }
  if (failed.some((op) => op.status === 429)) {
    return new RateLimitedException(DEFAULT_RATE_LIMIT_MS, system);
  }
  return new ConnectorException(message, HttpStatus.BAD_GATEWAY);
}
