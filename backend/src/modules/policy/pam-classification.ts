/**
 * PAM classification lookups — pure functions over well-known admin role/group maps.
 * Extracted from PamFilterService to break circular dependency with EntitlementCatalogService.
 */

export type AdminTier = 'TIER_0' | 'TIER_1' | 'TIER_2';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Well-known Windows RIDs for built-in AD admin groups (domain-agnostic).
 * Source of truth for PAM classification — connectors return raw RIDs as metadata,
 * and EntitlementCatalogService.absorbDiscovered() calls classifyByRid() to stamp
 * tier/riskLevel during catalog ingestion.
 */
export const WELL_KNOWN_AD_ADMIN_RIDS: ReadonlyMap<
  string,
  { tier: AdminTier; riskLevel: RiskLevel }
> = new Map([
  ['512', { tier: 'TIER_0', riskLevel: 'CRITICAL' }], // Domain Admins
  ['519', { tier: 'TIER_0', riskLevel: 'CRITICAL' }], // Enterprise Admins
  ['518', { tier: 'TIER_0', riskLevel: 'CRITICAL' }], // Schema Admins
  ['544', { tier: 'TIER_1', riskLevel: 'HIGH' }], // Administrators (Builtin)
  ['548', { tier: 'TIER_1', riskLevel: 'HIGH' }], // Account Operators
  ['549', { tier: 'TIER_1', riskLevel: 'HIGH' }], // Server Operators
  ['551', { tier: 'TIER_2', riskLevel: 'MEDIUM' }], // Backup Operators
  ['550', { tier: 'TIER_2', riskLevel: 'MEDIUM' }], // Print Operators
]);

/**
 * Well-known Entra ID directory role template IDs for built-in admin roles.
 * Source of truth for PAM classification — the connector returns raw templateIds
 * in metadata, and EntitlementCatalogService.absorbDiscovered() calls
 * classifyByTemplateId() to stamp tier/riskLevel during catalog ingestion.
 */
export const WELL_KNOWN_ENTRA_ADMIN_ROLES: ReadonlyMap<
  string,
  { tier: AdminTier; riskLevel: RiskLevel }
> = new Map([
  ['62e90394-69f5-4237-9190-012177145e10', { tier: 'TIER_0', riskLevel: 'CRITICAL' }], // Global Administrator
  ['29232cdf-9323-42fd-ade2-1d097af3e4de', { tier: 'TIER_0', riskLevel: 'CRITICAL' }], // Exchange Administrator
  ['194ae4cb-b126-40b2-bd5b-6091b380977d', { tier: 'TIER_0', riskLevel: 'CRITICAL' }], // Security Administrator
  ['fe930be7-5e62-47db-91af-98c3a49a38b1', { tier: 'TIER_1', riskLevel: 'HIGH' }], // User Administrator
  ['fdd7a751-b60b-444a-984c-02652fe8fa1c', { tier: 'TIER_1', riskLevel: 'HIGH' }], // Groups Administrator
  ['4d6ac14f-3453-41d0-bef9-a3e0c569773a', { tier: 'TIER_1', riskLevel: 'HIGH' }], // License Administrator
  ['729827e3-9c14-49f7-bb1b-9608f156bbb8', { tier: 'TIER_2', riskLevel: 'MEDIUM' }], // Helpdesk Administrator
  ['966707d0-3269-4727-9be2-8c3a10f19b9d', { tier: 'TIER_2', riskLevel: 'MEDIUM' }], // Password Administrator
]);

/**
 * Classify an AD group by its well-known RID.
 * Returns tier and riskLevel for known admin groups, or null for non-admin groups.
 */
export function classifyByRid(rid: string): { tier: AdminTier; riskLevel: RiskLevel } | null {
  return WELL_KNOWN_AD_ADMIN_RIDS.get(rid) ?? null;
}

/**
 * Classify an Entra ID directory role by its well-known template ID.
 * Returns tier and riskLevel for known admin roles, or null for non-admin roles.
 */
export function classifyByTemplateId(
  templateId: string,
): { tier: AdminTier; riskLevel: RiskLevel } | null {
  return WELL_KNOWN_ENTRA_ADMIN_ROLES.get(templateId) ?? null;
}
