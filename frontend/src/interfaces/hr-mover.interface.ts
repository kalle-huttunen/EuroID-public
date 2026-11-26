/**
 * HR-driven movers (backend `modules/mover`, HrMoversController): batches an HR sync paused above
 * the mass-mover limit, and the tenant mass-mover policy. Matches GET /movers/batches and
 * GET|PUT /movers/policy.
 */

export type MoverBatchStatus = 'pending' | 'approved' | 'rejected';

export type MoverBatchItemStatus =
  | 'pending-approval'
  | 'started'
  | 'superseded'
  | 'failed'
  | 'rejected';

/** One trigger attribute: the access baseline's value and the HR value. */
export interface ITriggerAttributeChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface IMoverBatchItem {
  itemId: string;
  identityId: string;
  displayName: string;
  email?: string;
  /** As detected, or as the approval started them. */
  changes: ITriggerAttributeChange[];
  status: MoverBatchItemStatus;
  workflowId?: string;
  closeReason?: string;
}

export interface IMoverBatch {
  id: string;
  sourceName: string;
  status: MoverBatchStatus;
  identityCount: number;
  /** Mover runs the sync could have started without approval. */
  allowance: number;
  activeIdentityCount: number;
  /** How many members changed each trigger attribute. */
  fieldCounts: Record<string, number>;
  createdAt?: string;
  decidedBy?: string;
  decidedAt?: string;
  comment?: string;
  startedCount?: number;
  items: IMoverBatchItem[];
}

/** The editable policy (PUT /movers/policy body). */
export interface IMoverPolicySettings {
  massMoverMaxCount: number;
  massMoverMaxPercent: number;
  /** Floor: a sync may always start this many. */
  massMoverMinCount: number;
}

export interface IMoverPolicy extends IMoverPolicySettings {
  /** False while the tenant runs on the defaults. */
  configured: boolean;
  updatedBy?: string;
  updatedAt?: string;
}
