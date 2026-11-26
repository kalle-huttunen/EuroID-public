import type { StandardUserDto } from '@shared/dtos/standard-user.dto';

/**
 * Employment lifecycle fields an HR connector maps through unchanged (field mapping only;
 * deciding who is a leaver is the leaver policy's job, `modules/leavers`).
 *
 * - `hrStatus`: the HR system's own employment status word ("Terminated", "left", ...),
 *   kept verbatim in `customAttributes.hrStatus`. `status` stays the Golden Record status.
 * - `startDate`: first day of employment (a "Start Date" column, a `start_date` key).
 * - `endDate`: last day of employment (an "End Date" or "Termination Date" column).
 */
export const HR_STATUS_FIELD = 'hrStatus';

/**
 * Custom attribute holding a start date HR sent that is not a date, as sent. HR joiner detection
 * keeps that person out of automatic onboarding until a sync reads a date (modules/joiners).
 */
export const START_DATE_UNREADABLE_FIELD = 'startDateUnreadable';

/** Rows a connector read but could not map; the ingest counts such a run as partial. */
export interface HrFetchStats {
  skipped: number;
  /**
   * When the caller passes an array, the connector appends the source row of each user it
   * returns, in the same order: the CSV line (the header is line 1; a quoted value spanning
   * lines shifts the count) or the 1-based position in the JSON feed, numbered like the
   * connector's "Skipping row" warnings. Ingest errors name the failed row by it.
   */
  sourceRows?: number[];
}

/**
 * Copy `hrStatus`, `startDate` and `endDate` from a mapped row onto the user. A date that is not a
 * date is left out (reported through `onInvalidDate`), so one bad cell does not fail the row; an
 * unreadable start date is kept as sent in `customAttributes.startDateUnreadable`.
 */
export function applyHrLifecycleFields(
  user: Partial<StandardUserDto>,
  mapped: Record<string, string>,
  onInvalidDate?: (field: string) => void,
): void {
  const hrStatus = mapped[HR_STATUS_FIELD];
  if (hrStatus) {
    user.customAttributes = { ...(user.customAttributes ?? {}), [HR_STATUS_FIELD]: hrStatus };
  }
  if (mapped.startDate) {
    const parsed = parseDate(mapped.startDate);
    if (parsed) {
      user.startDate = parsed;
    } else {
      onInvalidDate?.('startDate');
      user.customAttributes = {
        ...(user.customAttributes ?? {}),
        [START_DATE_UNREADABLE_FIELD]: mapped.startDate,
      };
    }
  }
  if (mapped.endDate) {
    const parsed = parseDate(mapped.endDate);
    if (parsed) user.endDate = parsed;
    else onInvalidDate?.('endDate');
  }
}

function parseDate(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
