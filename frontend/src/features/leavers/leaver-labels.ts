/** Display labels for leaver reasons and statuses (Leavers page, identity timeline). */
import type {
  DeprovisionOutcome,
  LeaverBatchStatus,
  LeaverEventStatus,
  LeaverReason,
  LinkedAdminOffboardingOutcome,
} from '../../interfaces';

export const REASON_LABEL: Record<LeaverReason, string> = {
  terminated: 'Terminated in HR',
  'end-date': 'End date passed',
  'missing-from-source': 'Missing from feed',
};

/** Ant Design Tag preset per reason (theme-driven, no raw colors). */
export const REASON_TAG: Record<LeaverReason, string> = {
  terminated: 'error',
  'end-date': 'warning',
  'missing-from-source': 'default',
};

export const EVENT_STATUS_LABEL: Record<LeaverEventStatus, string> = {
  'pending-approval': 'Waiting for approval',
  queued: 'Queued to start',
  started: 'Offboarding started',
  rejected: 'Rejected',
  superseded: 'Not started',
};

export const EVENT_STATUS_TAG: Record<LeaverEventStatus, string> = {
  'pending-approval': 'warning',
  queued: 'processing',
  started: 'success',
  rejected: 'default',
  superseded: 'default',
};

export const BATCH_STATUS_LABEL: Record<LeaverBatchStatus, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const BATCH_STATUS_TAG: Record<LeaverBatchStatus, string> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'default',
};

export const OUTCOME_LABEL: Record<DeprovisionOutcome, string> = {
  deprovisioned: 'Access removed',
  'already-gone': 'No account left',
  'not-applicable': 'Not applicable',
  failed: 'Failed',
  'removed-manually': 'Removed manually',
};

export const OUTCOME_TAG: Record<DeprovisionOutcome, string> = {
  deprovisioned: 'success',
  'already-gone': 'default',
  'not-applicable': 'default',
  failed: 'error',
  'removed-manually': 'warning',
};

/** What became of a linked admin account when its person was offboarded. */
export const ADMIN_OUTCOME_LABEL: Record<LinkedAdminOffboardingOutcome, string> = {
  offboarded: 'Offboarded',
  failed: 'Failed',
  'running-elsewhere': 'Offboarding elsewhere',
};

export const ADMIN_OUTCOME_TAG: Record<LinkedAdminOffboardingOutcome, string> = {
  offboarded: 'success',
  failed: 'error',
  'running-elsewhere': 'processing',
};

/** What the effective date means for a reason. */
export function effectiveDateLabel(reason: LeaverReason): string {
  return reason === 'missing-from-source' ? 'Last in feed' : 'End date';
}
