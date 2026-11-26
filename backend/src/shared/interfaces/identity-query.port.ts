/**
 * Port for querying identities from sibling modules.
 * Implemented by IdentityService, injected via IDENTITY_QUERY_PORT token.
 * Decouples consumers (PolicyEngineService, AccessRequestsService) from IdentityModule.
 */
export const IDENTITY_QUERY_PORT = Symbol('IDENTITY_QUERY_PORT');

export interface IIdentityQueryPort {
  findAllPaginated(
    start?: number,
    end?: number,
    options?: {
      includeDeleted?: boolean;
      filter?: Record<string, unknown>;
      trustedFilter?: boolean;
    },
  ): Promise<[Record<string, unknown>[], number]>;
  findById(
    id: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Record<string, unknown> | null>;
  findByEmail(
    email: string,
    options?: { includeDeleted?: boolean },
  ): Promise<Record<string, unknown> | null>;
  /**
   * The live identity's profile as the policy engine evaluates it for provisioning: every profile
   * field plus the contracts derived from its HR sources (buildProfileWithContractsForPolicy),
   * with `_id` and `tenantId`. Null when there is no such identity.
   */
  findPolicyProfileById(id: string): Promise<Record<string, unknown> | null>;
}
