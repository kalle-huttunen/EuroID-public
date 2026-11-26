/** Display labels for HR joiner batches (Joiners, movers and leavers page, HR joiners tab). */
import type { JoinerEventStatus } from '../../interfaces';

export const JOINER_STATUS_LABEL: Record<JoinerEventStatus, string> = {
  waiting: 'Waiting for the next sync',
  'pending-approval': 'Waiting for approval',
  started: 'Onboarding started',
  rejected: 'Rejected',
  superseded: 'Not started',
};

export const JOINER_STATUS_TAG: Record<JoinerEventStatus, string> = {
  waiting: 'processing',
  'pending-approval': 'warning',
  started: 'success',
  rejected: 'default',
  superseded: 'default',
};
