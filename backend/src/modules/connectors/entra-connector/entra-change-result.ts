/**
 * The result of one requested group, directory role or license change (an operation of a
 * ProvisioningIntent), as the Entra ID connector reports it: applied, unchanged (already as
 * requested) or failed, with the reason and the HTTP status of the exception (EntraClient maps
 * Graph's answer: 400 for a 4xx it refused, 502 for a 5xx or no answer, 404, 409, 429 as they
 * are, 401 for refused credentials). What a failed change means for a run is the caller's call.
 */
import { HttpException } from '@nestjs/common';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import type { ProvisioningOperationResult } from '@shared/dtos/provisioning-result.dto';
import type { ProvisioningIntent } from './entra.interface';

export type EntraOperation = ProvisioningIntent['operations'][number];

export function changeResult(
  op: EntraOperation,
  outcome: 'applied' | 'unchanged',
): ProvisioningOperationResult {
  return { type: op.type, action: op.action, targetId: op.targetId, outcome };
}

/** A change that was not made: the error's message, and its HTTP status when it has one. */
export function failedChange(op: EntraOperation, error: unknown): ProvisioningOperationResult {
  const status =
    error instanceof RateLimitedException
      ? 429
      : error instanceof HttpException
        ? error.getStatus()
        : undefined;
  return {
    type: op.type,
    action: op.action,
    targetId: op.targetId,
    outcome: 'failed',
    reason: error instanceof Error ? error.message : String(error),
    ...(status === undefined ? {} : { status }),
  };
}
