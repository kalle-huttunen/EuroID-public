/**
 * Port for entitlement catalog reads.
 * Implemented by EntitlementCatalogService, injected via ENTITLEMENT_CATALOG_PORT token.
 * Decouples consumers (AccessRequestsService, AccessReviewService, PolicyEngineService) from EntitlementCatalogModule.
 */
export const ENTITLEMENT_CATALOG_PORT = Symbol('ENTITLEMENT_CATALOG_PORT');

export interface CatalogEntryBatchResult {
  owner?: string;
  riskLevel: string;
}

export interface CatalogEntry {
  system: string;
  nativeId?: string;
  name?: string;
  owner?: string;
  riskLevel?: string;
  origin?: string;
  adminTier?: string;
  requiresAdminAccount?: boolean;
}

export interface IEntitlementCatalogPort {
  isPolicyManaged(system: string, nativeId?: string, name?: string): Promise<boolean>;
  findBySystemAndNativeId(system: string, nativeId: string): Promise<CatalogEntry | null>;
  getOwner(system: string, nativeId: string): Promise<string | null>;
  getCatalogEntriesBatch(
    pairs: Array<{ system: string; nativeId: string }>,
  ): Promise<Map<string, CatalogEntryBatchResult>>;
}
