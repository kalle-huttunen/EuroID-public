/**
 * Workflows Index
 *
 * Export all workflows for Temporal worker registration. The worker bundles this module
 * (src/workflows in development, dist/src/workflows for workflow-bundle.js in production) and
 * registers the workflow types it exports; a workflow missing here never runs, even when a
 * schedule starts it (worker-scheduled-workflows.spec.ts).
 */

export * from './onboarding.workflow';
export * from './offboarding.workflow';
export * from './bulk-provisioning.workflow';
export * from './distributed-transaction.workflow';
export * from './reconciliation.workflow';
export * from './reconcile-batch.workflow';
export * from './access-review.workflow';
export * from './archival.workflow';
export * from './scheduled-sync.workflow';
export * from './entitlement-expiry.workflow';
export * from './admin-account-provisioning.workflow';
export * from './privileged-session.workflow';
export * from './access-request-approval.workflow';
export * from './risk-score-calculation.workflow';
export * from './orphan-cleanup.workflow';
export * from './mover.workflow';
export * from './credential-rotation.workflow';
export * from './recertification-scheduler.workflow';
export * from './intelligence-batch.workflow';
export * from './audit-archive.workflow';
