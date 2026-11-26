/**
 * The provisioning operation type of an entitlement. Pure TypeScript (no NestJS dependencies).
 *
 * The policy engine, the connectors (ProvisioningIntent) and SoD policies name a directory role
 * `role`; the entitlement catalog and an access request name its type `DirectoryRole`. Access
 * request fulfilment, SoD checks and SoD policies stored as `directoryrole` (before plan 2.9 an
 * access request lower-cased the catalog type) all go through this mapping, so one SoD policy
 * covers a directory role on every path.
 */

/**
 * `group`, `license` or `role` for a catalog type (`Group`, `License`, `DirectoryRole`) or an
 * operation type in any case; other types lower-cased; a missing type is a group, as an access
 * request entitlement without a type always was.
 */
export function toOperationType(type: string | undefined | null): string {
  const t = (type ?? 'Group').toLowerCase();
  return t === 'directoryrole' ? 'role' : t;
}
