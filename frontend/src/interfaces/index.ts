/**
 * [FRONTEND INTERFACES]
 * ---------------------
 * Backend-sourced types come from generated/api.types.ts (run `npm run generate:api`).
 * Frontend-only types remain in this directory.
 */

// Standard user (from generated StandardUserDto + compat aliases)
export * from './standard-user.interface';

// User helpers (getUserDisplayName, getUserStatusColor, getEmploymentTypeLabel)
export {
  getUserDisplayName,
  getUserStatusColor,
  getEmploymentTypeLabel,
} from '../utils/user-helpers';

// Impact analysis (blueprint simulation)
export * from './impact-analysis.interface';

// User timeline / activity feed
export * from './timeline.interface';

// Reconciliation (drift, connector health)
export * from './reconciliation.interface';

// Bulk operations (CSV import, batch provisioning)
export * from './bulk-operation.interface';

// Audit & Compliance (event log; backend GET /api/v1/audit not yet implemented)
export * from './audit.interface';

// Developer Tools (Workflow Debugger, Transaction Viewer; APIs future)
export * from './developer.interface';

// Correlation config (Brain identity linking, mastery, writeback)
export * from './correlation-config.interface';

// Uncorrelated Queue (brownfield manual linking)
export * from './uncorrelated.interface';

// Reconciliation config (per-tenant mastery, HR tags, source priority)
export * from './reconciliation-config.interface';

// Policy catalog (groups, roles for PolicyEditor)
export * from './policy-catalog.interface';

// HR leavers (mass-leaver batches, leaver policy)
export * from './leaver.interface';

// Access preview and re-evaluation (mover)
export * from './access-preview.interface';

// HR-driven movers (mass-mover batches, mover policy)
export * from './hr-mover.interface';

// HR-driven joiners (mass-joiner batches, joiner policy)
export * from './joiner.interface';

// Dead-letter queue (failed events, workflows, connector calls)
export * from './dead-letter.interface';

// Segregation-of-duties policies
export * from './sod-policy.interface';

// Credential lifecycle (inventory rows from the nightly run, compliance summary, policies)
export * from './credential-lifecycle.interface';

// Non-human identities (agents, delegation, kill switch, short-lived credentials)
export * from './nhi.interface';

// Outbound webhooks (event subscriptions, delivery attempts, test delivery)
export * from './webhook.interface';

// Admin users (console sign-ins of the tenant, invites)
export * from './admin-user.interface';

// Expired access the expiry run could not remove (retry, removed manually)
export * from './expired-access.interface';

// Access review exclusions (revoked access the policies no longer grant; lift, counts per policy)
export * from './review-exclusion.interface';

// Field mastery of an identity (HR-mastered fields, department and job title overrides)
export * from './identity-mastery.interface';

// GDPR requests (consent records, data subject access export, erasure attestation)
export * from './gdpr.interface';

// Audit integrity (hash chain, Merkle checkpoints, event proofs, signed anchors)
export * from './audit-integrity.interface';

// Access explorer (identity access graph, entitlement holders, access path, SoD, resync)
export * from './access-explorer.interface';

// Access intelligence (reviewer quality, peer groups and outliers, recommendations, unusual check)
export * from './access-intelligence.interface';
