/**
 * Policy catalog types for entitlement catalog (groups, roles).
 * Used by PolicyEditor and related components.
 */

export interface CatalogGroup {
  name: string;
  nativeId: string;
  system: string;
}

export interface CatalogRole {
  name: string;
  nativeId: string;
  system: string;
  adminTier?: string;
}
