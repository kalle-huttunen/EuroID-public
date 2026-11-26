/**
 * Labels and shared text of the credential lifecycle page and the identity page's Credentials tab.
 */
import dayjs from 'dayjs';
import type { CredentialStatus } from '../../interfaces';

export const STATUS_LABEL: Record<CredentialStatus, string> = {
  COMPLIANT: 'Compliant',
  EXPIRING_SOON: 'Expiring soon',
  EXPIRED: 'Overdue',
  UNKNOWN: 'Could not be checked',
};

/** antd preset tag colours (theme-aware). */
export const STATUS_TAG: Record<CredentialStatus, string> = {
  COMPLIANT: 'success',
  EXPIRING_SOON: 'warning',
  EXPIRED: 'error',
  UNKNOWN: 'default',
};

/** The systems the nightly run reads, as inventory rows and policy scopes name them. */
export const SYSTEM_OPTIONS = [
  { value: 'entra-id', label: 'Entra ID' },
  { value: 'ad', label: 'Active Directory' },
];

export function systemLabel(system: string): string {
  return SYSTEM_OPTIONS.find((o) => o.value === system)?.label ?? system;
}

/** EmploymentType values of the Golden Record (`standard-user.dto.ts`). */
export const EMPLOYMENT_TYPE_OPTIONS = [
  { value: 'FULL_TIME', label: 'Full time' },
  { value: 'PART_TIME', label: 'Part time' },
  { value: 'CONTRACTOR', label: 'Contractor' },
  { value: 'INTERN', label: 'Intern' },
  { value: 'CONSULTANT', label: 'Consultant' },
  { value: 'SERVICE_ACCOUNT', label: 'Service account' },
  { value: 'ADMIN_ACCOUNT', label: 'Admin account' },
];

export function employmentTypeLabel(value: string): string {
  return EMPLOYMENT_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/** Where the rows come from, for empty states and the page subtitle. */
export const WHERE_ENTRIES_COME_FROM =
  'Every night (03:00 unless CREDENTIAL_ROTATION_CRON says otherwise) EuroID reads the last ' +
  'password change of each account it provisioned in Entra ID or Active Directory and compares ' +
  'it with the credential policy that applies.';

/** Why nothing is reset: shown on the page and in the policy form. */
export const NO_RESET_TITLE = 'Automatic password reset is off';
export const NO_RESET_NOTE =
  'EuroID resets no password: automatic reset needs secret storage, which EuroID does not have ' +
  'yet, and a person’s password is never reset automatically. An overdue password is changed in ' +
  'Entra ID or Active Directory; the next nightly check sees the change.';

export function formatDate(iso: string | undefined): string {
  return iso ? dayjs(iso).format('YYYY-MM-DD') : '—';
}

export function formatDateTime(iso: string | undefined): string {
  return iso ? dayjs(iso).format('YYYY-MM-DD HH:mm') : '—';
}

/** "Overdue by 3 days", "Due today", "In 12 days" (calendar days, local time). */
export function dueText(nextRotation: string | undefined, now: dayjs.Dayjs = dayjs()): string {
  if (!nextRotation) return '';
  const days = dayjs(nextRotation).startOf('day').diff(now.startOf('day'), 'day');
  if (days < 0) return `Overdue by ${-days} day${days === -1 ? '' : 's'}`;
  if (days === 0) return 'Due today';
  return `In ${days} day${days === 1 ? '' : 's'}`;
}
