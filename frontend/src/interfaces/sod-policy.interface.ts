/**
 * Segregation-of-duties policies (backend `modules/policy/sod.service.ts`, `sod-policies` routes).
 * Shapes of GET /sod-policies (`SodPolicyResponse`: the document's `_id` as `id`) and of the
 * create and update bodies (`create-sod-policy.dto.ts`, `update-sod-policy.dto.ts`). The swagger
 * spec types these bodies as unknown, so they are written out here.
 */

export type SodSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** BLOCK refuses or stops what the policy matches; WARN only reports it. */
export type SodAction = 'BLOCK' | 'WARN';

/**
 * One entitlement of a policy. Matched against an operation's target system and type
 * (case-insensitive) and its entitlement id (exact): `group`, `license` or `role` from the policy
 * engine, the catalog entry's type in lower case from an access request.
 */
export interface SodEntitlementRef {
  system: string;
  type: string;
  targetId: string;
}

export interface ISodPolicy {
  /** ObjectId string; the PATCH and DELETE routes take it. */
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  severity: SodSeverity;
  /** Two or more; a person violates the policy when one evaluation grants all of them. */
  conflictingEntitlements: SodEntitlementRef[];
  isActive: boolean;
  action: SodAction;
  createdAt?: string;
  updatedAt?: string;
}

/** POST /sod-policies. */
export interface ICreateSodPolicy {
  name: string;
  description?: string;
  severity: SodSeverity;
  conflictingEntitlements: SodEntitlementRef[];
  action: SodAction;
  isActive: boolean;
}

/** PATCH /sod-policies/:id: only these three fields can change. */
export type IUpdateSodPolicy = Partial<Pick<ISodPolicy, 'severity' | 'action' | 'isActive'>>;
