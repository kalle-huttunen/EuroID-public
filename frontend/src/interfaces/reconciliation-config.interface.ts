export interface IReconciliationConfig {
  _id?: string;
  tenantId: string;
  hrSourceTags: string[];
  sourcePriorityOrder: string[];
  contractCriticalFields: string[];
  defaultMastery: Record<string, string[]>;
  targetIdKeys: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * The tenant's default mastery (IReconciliationConfig.defaultMastery) as the Design studio can
 * read it: GET /admin/reconciliation-config needs policy-admin.
 */
export type DefaultMasteryView =
  | { state: 'loaded'; mastery: Record<string, string[]> }
  | { state: 'unconfigured' }
  | { state: 'unreadable' }
  | { state: 'loading' };
