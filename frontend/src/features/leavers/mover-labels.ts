/** Display labels for HR mover batches (Leavers page, HR movers tab). */
import type { MoverBatchItemStatus } from '../../interfaces';

/** The mover's trigger attributes. */
export const FIELD_LABEL: Record<string, string> = {
  departmentName: 'Department',
  jobTitle: 'Job title',
  location: 'Location',
  managerEmail: 'Manager',
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

/** An attribute value as text; an empty or missing value reads "(empty)". */
export function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export const MOVER_ITEM_STATUS_LABEL: Record<MoverBatchItemStatus, string> = {
  'pending-approval': 'Waiting for approval',
  started: 'Mover started',
  superseded: 'Not started',
  failed: 'Start failed',
  rejected: 'Rejected',
};

export const MOVER_ITEM_STATUS_TAG: Record<MoverBatchItemStatus, string> = {
  'pending-approval': 'warning',
  started: 'success',
  superseded: 'default',
  failed: 'error',
  rejected: 'default',
};
