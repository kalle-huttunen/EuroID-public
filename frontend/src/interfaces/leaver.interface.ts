/**
 * HR-driven leavers (backend `modules/leavers`): paused mass-leaver batches, offboardings that
 * left a target failed and the tenant leaver policy. Matches GET /leavers/batches,
 * GET /leavers/open-offboardings and GET|PUT /leavers/policy.
 */

export type LeaverReason = 'terminated' | 'end-date' | 'missing-from-source';

export type LeaverBatchStatus = 'pending' | 'approved' | 'rejected';

export type LeaverEventStatus =
  | 'pending-approval'
  | 'queued'
  | 'started'
  | 'rejected'
  | 'superseded';

/**
 * What offboarding did in one target system (backend `shared/types/deprovision.ts`).
 * `removed-manually`: it failed and an admin confirmed removing the account by hand.
 */
export type DeprovisionOutcome =
  | 'deprovisioned'
  | 'already-gone'
  | 'not-applicable'
  | 'failed'
  | 'removed-manually';

/** An admin's confirmation that a failed target's account was removed outside EuroID. */
export interface IManualRemoval {
  by: string;
  at: string;
  reason: string;
}

export interface IOffboardingSystemResult {
  system: string;
  outcome: DeprovisionOutcome;
  /** What the target did, e.g. "deactivated". */
  detail?: string;
  /** Why it failed or is not applicable (kept after a manual removal). */
  reason?: string;
  manualRemoval?: IManualRemoval;
}

/**
 * What became of a linked admin account (PAM) when its person was offboarded (backend
 * `shared/types/deprovision.ts`): each is offboarded first by its own offboarding run.
 * `running-elsewhere`: its offboarding was already running and reports its own result.
 */
export type LinkedAdminOffboardingOutcome = 'offboarded' | 'failed' | 'running-elsewhere';

export interface ILinkedAdminOffboardingResult {
  identityId: string;
  /** Its own offboarding run (`t-<tenant>-offboard-<identityId>`). */
  workflowId: string;
  outcome: LinkedAdminOffboardingOutcome;
  /** Why it failed or was not waited for. */
  reason?: string;
}

/** The started offboarding's result, once its workflow finished or stopped. */
export interface ILeaverOffboardingResult {
  status: 'completed' | 'partial-failure';
  /** Golden Record: deleted, or suspended (login disabled) while a target or admin account failed. */
  hubStatus: 'deleted' | 'suspended';
  systems: IOffboardingSystemResult[];
  /** The person's linked admin accounts; absent when there were none. */
  linkedAdmins?: ILinkedAdminOffboardingResult[];
  finishedAt: string;
}

export interface ILeaverBatchItem {
  leaverEventId: string;
  identityId: string;
  displayName: string;
  email?: string;
  reason: LeaverReason;
  /** End date (terminated, end-date) or last time the feed delivered the person. */
  effectiveDate?: string;
  status: LeaverEventStatus;
  workflowId?: string;
  closeReason?: string;
  /** Its offboarding could not start (Temporal down); it stays queued for the next sync. */
  startError?: string;
  offboarding?: ILeaverOffboardingResult;
}

/**
 * An offboarding that left a target failed (GET /leavers/open-offboardings), whatever started
 * it: an HR leaver (`leaver`), or deleting the user (no `leaver`).
 */
export interface IFailedOffboarding {
  workflowId: string;
  identityId: string;
  displayName: string;
  email?: string;
  leaver?: {
    leaverEventId: string;
    sourceName: string;
    reason: LeaverReason;
    effectiveDate?: string;
  };
  offboarding: ILeaverOffboardingResult;
}

export interface ILeaverBatch {
  id: string;
  sourceName: string;
  status: LeaverBatchStatus;
  identityCount: number;
  /** Leavers the sync could have started without approval. */
  allowance: number;
  activeIdentityCount: number;
  reasonCounts: Partial<Record<LeaverReason, number>>;
  createdAt?: string;
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
  startedCount?: number;
  items: ILeaverBatchItem[];
}

export interface ILeaverSignalToggles {
  terminated: boolean;
  endDate: boolean;
  missingFromSource: boolean;
}

/** The editable policy (PUT /leavers/policy body). */
export interface ILeaverPolicySettings {
  signals: ILeaverSignalToggles;
  terminatedStatuses: string[];
  missingSyncThreshold: number;
  massLeaverMaxCount: number;
  massLeaverMaxPercent: number;
  /** Leavers one sync may always start without approval (floor), at most massLeaverMaxCount. */
  massLeaverMinCount: number;
  timezone: string;
}

export interface ILeaverPolicy extends ILeaverPolicySettings {
  /** False while the tenant runs on the defaults. */
  configured: boolean;
  updatedBy?: string;
  updatedAt?: string;
}
