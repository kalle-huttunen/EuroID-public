/**
 * An inbound (HR) record that belongs to a soft-deleted identity (`deletedAt` set by offboarding):
 * what it means. Pure; IdentityDeletedMatchService reads the tenant's leaver policy and acts on it.
 *
 * - `ended`: the record says the person left (a terminated status or an end date that has passed,
 *   read as leaver detection reads them, or a TERMINATED / DELETED status). Nothing changes.
 * - `rehire`: an active record whose start date is after the deletion. The identity is revived.
 * - `not-rehire`: any other active record. Nothing changes; the HR ingest counts it.
 */
import { HttpStatus } from '@nestjs/common';
import { IdentityException } from '@shared/exceptions/domain-exceptions';
import { UserStatus, type StandardUserDto } from '@shared/dtos/standard-user.dto';
import { evaluateLeaverSignal } from '../leavers/leaver-signals';
import type { LeaverPolicySettings } from '../leavers/leaver-policy.defaults';

export type DeletedIdentityRow = 'ended' | 'rehire' | 'not-rehire';

/** The record changed nothing: it belongs to a deleted identity and is not a rehire. */
export class DeletedIdentityRowIgnored extends IdentityException {
  constructor(
    readonly identityId: string,
    readonly row: Exclude<DeletedIdentityRow, 'rehire'>,
  ) {
    super(
      `Identity ${identityId} was deleted; this record is not a rehire (${row}) and changed nothing`,
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * Whether a record that shares a deleted identity's email is another person: it carries an
 * employee number, and the identity's records carry others, none of them it. The email is unique
 * among live identities only, so a new hire can take a former employee's address; the employee
 * number stays the former employee's.
 */
export function isAnotherEmployee(
  identity: { sources?: Array<{ rawData?: Record<string, unknown> }> },
  record: Pick<StandardUserDto, 'employeeNumber'>,
): boolean {
  const number = record.employeeNumber?.trim();
  if (!number) return false;
  const held = (identity.sources ?? [])
    .map((s) => s.rawData?.employeeNumber)
    .filter((n): n is string | number => typeof n === 'string' || typeof n === 'number')
    .map((n) => String(n).trim())
    .filter(Boolean);
  return held.length > 0 && !held.includes(number);
}

function toDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function classifyDeletedIdentityRow(
  row: StandardUserDto,
  deletedAt: Date,
  policy: LeaverPolicySettings,
  now: Date,
): DeletedIdentityRow {
  if (row.status === UserStatus.TERMINATED || row.status === UserStatus.DELETED) return 'ended';
  const hrStatus = (row.customAttributes as { hrStatus?: unknown } | undefined)?.hrStatus;
  const signal = evaluateLeaverSignal(
    {
      hrStatus: typeof hrStatus === 'string' ? hrStatus : row.status,
      endDate: toDate(row.endDate),
    },
    policy,
    { now },
  );
  if (signal) return 'ended';
  const startDate = toDate(row.startDate);
  return startDate && startDate.getTime() > deletedAt.getTime() ? 'rehire' : 'not-rehire';
}
