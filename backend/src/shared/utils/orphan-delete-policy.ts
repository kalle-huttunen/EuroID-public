/**
 * Which orphan accounts EuroID deletes. Entra ID and SCIM orphans are deleted on request (the
 * DELETE action) or after the extended grace (ORPHAN_AUTO_DELETE_AFTER_EXTENDED). An Active
 * Directory orphan never is: AD gives no recycle bin guarantee and a deleted account's SID is
 * lost, so the account stays disabled and its drift quarantined with this reason recorded.
 * Pure TypeScript, no NestJS dependencies (importable from Temporal workflows).
 */
import { getSystemType } from './normalize-system-name';

export const AD_ORPHAN_KEPT_REASON =
  'EuroID never deletes an Active Directory account: AD gives no recycle bin guarantee and a ' +
  "deleted account's SID is lost. The account stays disabled and quarantined; delete it in " +
  'Active Directory by hand if it must go.';

/** Why EuroID refuses to delete an orphan account of `system`; undefined when it deletes it. */
export function orphanDeleteRefusal(system: string | undefined | null): string | undefined {
  return getSystemType(system) === 'ad' ? AD_ORPHAN_KEPT_REASON : undefined;
}
