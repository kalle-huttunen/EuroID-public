/**
 * Undoing a claim on an approval step (AccessRequestDecisionService). An approval, a rejection or
 * a delegation is written to the request before the approval workflow is told, so two approvers
 * never decide one step; when the workflow cannot be reached the claim is undone and the
 * approver tries again. Each release matches only its own claim (pure).
 */
import type { UpdateQuery } from 'mongoose';
import type { AccessRequestDocument, ApprovalStep } from './schemas/access-request.schema';

export interface ClaimRelease {
  /** Added to `{ requestId, tenantId }`. */
  filter: Record<string, unknown>;
  update: UpdateQuery<AccessRequestDocument>;
}

/**
 * An approval or rejection claimed at `decidedAt` (the claim's own timestamp): the step waits
 * for a decision again, and a rejected request is pending approval again.
 */
export function releaseDecision(
  stepIndex: number,
  decidedAt: Date,
  rejected: boolean,
): ClaimRelease {
  const step = `approvalSteps.${stepIndex}`;
  return {
    filter: { [`${step}.decidedAt`]: decidedAt },
    update: {
      $set: {
        [`${step}.status`]: 'PENDING',
        ...(rejected ? { status: 'PENDING_APPROVAL' } : {}),
      },
      $unset: {
        [`${step}.decidedAt`]: 1,
        [`${step}.decidedBy`]: 1,
        [`${step}.justification`]: 1,
      },
    },
  };
}

export type StepApprover = Pick<ApprovalStep, 'approverId' | 'approverEmail' | 'delegatedFrom'>;

const APPROVER_KEYS = ['approverId', 'approverEmail', 'delegatedFrom'] as const;

/**
 * A delegation of a still pending step to `delegated`: the step's approver is `previous` again
 * (a field `previous` did not have is removed, so a ROLE step is the role's again).
 */
export function releaseDelegation(
  stepIndex: number,
  previous: StepApprover,
  delegated: Required<StepApprover>,
): ClaimRelease {
  const step = `approvalSteps.${stepIndex}`;
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};
  for (const key of APPROVER_KEYS) {
    const value = previous[key];
    if (value === undefined || value === null) $unset[`${step}.${key}`] = 1;
    else $set[`${step}.${key}`] = value;
  }
  return {
    filter: {
      [`${step}.status`]: 'PENDING',
      [`${step}.approverId`]: delegated.approverId,
      [`${step}.delegatedFrom`]: delegated.delegatedFrom,
    },
    update: {
      ...(Object.keys($set).length > 0 ? { $set } : {}),
      ...(Object.keys($unset).length > 0 ? { $unset } : {}),
    },
  };
}
