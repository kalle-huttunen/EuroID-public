/**
 * What a mover run (access change for an already provisioned identity) did. Pure types and one
 * constant list, free of imports: the mover workflow imports it, as do its activities, domain
 * events and the identity timeline. System names, entitlement ids (group or license names) and
 * attribute names only: no names, emails or other personal data.
 */

/**
 * What started the run:
 * - attribute-change: PATCH /identity/:id changed one of the mover's trigger attributes
 * - re-evaluate: an operator asked for it (POST /identity/:id/access/re-evaluate)
 * - hr-sync: an HR sync left a trigger attribute different from the access baseline
 *   (modules/mover/hr-mover-detection.service.ts), or an admin approved such a paused batch
 */
export type MoverTrigger = 'attribute-change' | 're-evaluate' | 'hr-sync';

/**
 * One target system in a mover run:
 * - updated: the removals and additions were applied
 * - failed: applying them failed (`reason`); the run stopped there
 * - not-supported: the system has changes the mover does not apply (`reason`, absent in runs
 *   from before patch mover:identity-by-id): a system other than Entra ID, Active Directory,
 *   Okta and SCIM, or a kind of entitlement its connector does not change (MOVER_OPERATION_TYPES).
 *   A system can have an `updated` (or `failed`) entry and a `not-supported` one.
 * - not-attempted: the run stopped at an earlier system's failure
 * - no-account: the identity is not provisioned to the system (MoverEvaluation.provisionedSystems),
 *   so the run did not try it there (`reason`) and went on with the next system
 * `added` and `removed` are the entitlement ids (targetId) the change adds and removes.
 */
export interface MoverSystemResult {
  system: string;
  outcome: 'updated' | 'failed' | 'not-supported' | 'not-attempted' | 'no-account';
  added: string[];
  removed: string[];
  reason?: string;
}

/**
 * - completed: every system with changes was handled (see `systems` for any not supported)
 * - no-change: the policies give the same entitlements before and after
 * - skipped: the pipeline is paused or stopped (`reason`)
 * - failed: the run failed (`reason`); `systems` says how far it got
 */
export type MoverStatus = 'completed' | 'no-change' | 'skipped' | 'failed';

export interface MoverOutcome {
  identityId: string;
  workflowId: string;
  trigger: MoverTrigger;
  status: MoverStatus;
  /** Profile attributes whose change the run evaluated. */
  changedFields: string[];
  /** Entitlements the policy change adds and removes in total. */
  added: number;
  removed: number;
  systems: MoverSystemResult[];
  reason?: string;
  durationMs: number;
}

/** Connectors the mover changes access through, each on its own task queue. */
export const MOVER_CONNECTORS = ['entra', 'ad', 'okta', 'scim'] as const;
export type MoverConnector = (typeof MOVER_CONNECTORS)[number];

/** One access change as it travels through workflow history: the entitlement id only. */
export interface MoverAccessOperation {
  type: string;
  action: 'add' | 'remove';
  targetId: string;
}

/**
 * What one connector applies for one identity. Ids only: the activity reads the identity, its
 * account in the target and the connector config itself, so no email or profile enters history.
 */
export interface MoverAccessTask {
  identityId: string;
  connector: MoverConnector;
  /** Removals first, then additions. */
  operations: MoverAccessOperation[];
}

/** A connector's answer: memberships changed, and those already as the policies want them. */
export interface MoverAccessResult {
  changed: number;
  unchanged: number;
}

/** A policy operation as the mover's evaluation returns it (no policy params). */
export interface MoverPolicyOperation {
  type: string;
  action: string;
  target: string;
  targetId: string;
  sourcePolicy?: string;
}

/**
 * The policies before and after the move, evaluated by an activity that reads the identity by id
 * (MoverActivities.evaluateMoverChange): what history carries instead of the profile.
 */
export interface MoverEvaluation {
  /** The current values of the changed attributes: the access baseline after a completed run. */
  applied: Record<string, unknown>;
  toAdd: MoverPolicyOperation[];
  toRemove: MoverPolicyOperation[];
  /** Operations of the evaluation with the previous and with the current values. */
  operationCounts: { before: number; after: number };
  /**
   * The target systems (provisioning entry names) the identity has an account in: the run
   * changes access there only. Provisioned once, until a deprovision, also while a later run
   * there is in ERROR (IdentityProvisioningService hasProvisionedAccount).
   */
  provisionedSystems: string[];
}
