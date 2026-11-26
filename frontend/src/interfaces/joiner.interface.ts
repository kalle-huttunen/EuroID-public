/**
 * HR-driven joiners (backend `modules/joiners`, JoinersController): batches an HR sync paused
 * above the mass-joiner limit, and the tenant mass-joiner policy. Matches GET /joiners/batches and
 * GET|PUT /joiners/policy.
 */

export type JoinerBatchStatus = 'pending' | 'approved' | 'rejected';

export type JoinerEventStatus =
  | 'waiting'
  | 'pending-approval'
  | 'started'
  | 'rejected'
  | 'superseded';

export interface IJoinerBatchItem {
  joinerEventId: string;
  identityId: string;
  displayName: string;
  email?: string;
  departmentName?: string;
  jobTitle?: string;
  status: JoinerEventStatus;
  workflowId?: string;
  /** Why it closed without an onboarding. */
  closeReason?: string;
  /** The approval could not start it; the next full sync tries again. */
  startError?: string;
}

export interface IJoinerBatch {
  id: string;
  sourceName: string;
  status: JoinerBatchStatus;
  identityCount: number;
  /** Onboarding runs the sync could have started without approval. */
  allowance: number;
  activeIdentityCount: number;
  createdAt?: string;
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
  startedCount?: number;
  items: IJoinerBatchItem[];
}

/** The editable policy (PUT /joiners/policy body). */
export interface IJoinerPolicySettings {
  massJoinerMaxCount: number;
  massJoinerMaxPercent: number;
  /** Floor: a sync may always start this many. */
  massJoinerMinCount: number;
}

export interface IJoinerPolicy extends IJoinerPolicySettings {
  /** False while the tenant runs on the defaults. */
  configured: boolean;
  updatedBy?: string;
  updatedAt?: string;
}
