/** Display labels for access review revocation outcomes (Access reviews page). */
import type { RevocationOutcome } from '@api/intelligence-api';

export const REVOCATION_LABEL: Record<RevocationOutcome, string> = {
  removed: 'Removed',
  'already-gone': 'Already gone',
  'manual-action-needed': 'Manual action needed',
  failed: 'Failed',
};

/** Ant Design Tag preset per outcome (theme-driven, no raw colors). */
export const REVOCATION_TAG: Record<RevocationOutcome, string> = {
  removed: 'success',
  'already-gone': 'default',
  'manual-action-needed': 'warning',
  failed: 'error',
};
