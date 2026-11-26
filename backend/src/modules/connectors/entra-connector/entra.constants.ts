/** Connector system identifier used in entitlement catalog and events. */
export const ENTRA_SYSTEM = 'entra-id';

/** GUID regex (Entra object IDs are 36-char hex with dashes). */
export const GUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Maximum allowed length for a group display name in OData filters. */
export const MAX_GROUP_NAME_LENGTH = 256;

/** Escape value for OData filter string literal (single-quote doubling). */
export function escapeODataStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}
