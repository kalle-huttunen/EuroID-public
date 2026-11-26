/**
 * The activity map of the default task queue (provisioning-default): workflow-generic
 * activities plus the connector activities without a queue of their own. worker.ts builds the
 * activity instances from the Nest app; connectors with a plugin queue register there instead.
 */
import type { HrActivities } from './activities/hr.activities';
import type { IdentityActivities } from './activities/identity.activities';
import type { EntraActivities } from './activities/entra.activities';
import type { BulkProvisioningActivities } from './activities/bulk-provisioning.activities';
import type { RateLimiterActivities } from './activities/rate-limiter.activities';
import type { DistributedTransactionActivities } from './activities/distributed-transaction.activities';
import type { ReconciliationActivities } from './activities/reconciliation.activities';
import type { PolicyActivities } from './activities/policy.activities';
import type { ConfigActivities } from './activities/config.activities';
import type { AccessReviewActivities } from './activities/access-review.activities';
import type { AccessReviewRevocationActivities } from './activities/access-review-revocation.activities';
import type { WritebackActivities } from './activities/writeback.activities';
import type { PipelineActivities } from './activities/pipeline.activities';
import type { ScheduledSyncActivities } from './activities/scheduled-sync.activities';
import type { ArchivalActivities } from './activities/archival.activities';
import type { EntitlementExpiryActivities } from './activities/entitlement-expiry.activities';
import type { PrivilegedAccessActivities } from './activities/privileged-access.activities';
import type { AccessRequestActivities } from './activities/access-request.activities';
import type { RiskScoreActivities } from './activities/risk-score.activities';
import type { RecertificationActivities } from './activities/recertification.activities';
import type { OrphanActivities } from './activities/orphan.activities';
import type { IntelligenceActivities } from './activities/intelligence.activities';
import type { AuditArchiveActivities } from './activities/audit-archive.activities';
import type { CredentialActivities } from './activities/credential.activities';
import type { MoverActivities } from './activities/mover.activities';
import type { CredentialRotationActivities } from './activities/credential-rotation.activities';
import type { GitHubActivities } from './activities/github.activities';
import type { ServiceNowActivities } from './activities/servicenow.activities';
import type { OffboardingActivities } from './activities/offboarding.activities';
import type { NoAccountTargetActivities } from './activities/no-account-target.activities';

/**
 * Onboarding's health and provision activities for the targets without a task queue of their
 * own. Onboarding and admin account provisioning schedule them on the default queue as
 * check<System>Health and provisionUserTo<System>, <System> being the canvas system name with
 * its first letter capitalised (getHealthMethodName in onboarding-health-check.ts,
 * getProvisionMethodName in onboarding.workflow.ts), so the activity type names keep the canvas
 * spelling, hyphen included.
 */
export function defaultQueueTargetActivities(context: {
  github: GitHubActivities;
  serviceNow: ServiceNowActivities;
  noAccountTargets: NoAccountTargetActivities;
}): Record<string, unknown> {
  const { github, serviceNow, noAccountTargets: noAccount } = context;
  return {
    checkGithubHealth: github.checkGitHubHealth.bind(github),
    provisionUserToGithub: github.provisionUserToGitHub.bind(github),
    checkServicenowHealth: serviceNow.checkServiceNowHealth.bind(serviceNow),
    provisionUserToServicenow: serviceNow.provisionUserToServiceNow.bind(serviceNow),
    'checkDiscord-webhookHealth': noAccount.checkDiscordWebhookHealth.bind(noAccount),
    'provisionUserToDiscord-webhook': noAccount.provisionUserToDiscordWebhook.bind(noAccount),
    'checkGoogle-sheetsHealth': noAccount.checkGoogleSheetsHealth.bind(noAccount),
    'provisionUserToGoogle-sheets': noAccount.provisionUserToGoogleSheets.bind(noAccount),
    'checkFile-outboundHealth': noAccount.checkFileOutboundHealth.bind(noAccount),
    'provisionUserToFile-outbound': noAccount.provisionUserToFileOutbound.bind(noAccount),
  };
}

/** Build the full activity map for the default queue (workflows + generic + all connector activities) */
export function buildDefaultActivities(context: {
  hr: HrActivities;
  identity: IdentityActivities;
  entra: EntraActivities;
  bulk: BulkProvisioningActivities;
  rateLimiter: RateLimiterActivities;
  distributedTx: DistributedTransactionActivities;
  reconciliation: ReconciliationActivities;
  policy: PolicyActivities;
  config: ConfigActivities;
  accessReview: AccessReviewActivities;
  accessReviewRevocation: AccessReviewRevocationActivities;
  writeback: WritebackActivities;
  pipeline: PipelineActivities;
  scheduledSync: ScheduledSyncActivities;
  archival: ArchivalActivities;
  entitlementExpiry: EntitlementExpiryActivities;
  privilegedAccess: PrivilegedAccessActivities;
  accessRequest: AccessRequestActivities;
  riskScore: RiskScoreActivities;
  recertification: RecertificationActivities;
  orphan: OrphanActivities;
  intelligence: IntelligenceActivities;
  auditArchive: AuditArchiveActivities;
  credential: CredentialActivities;
  mover: MoverActivities;
  credentialRotation: CredentialRotationActivities;
  github: GitHubActivities;
  serviceNow: ServiceNowActivities;
  offboarding: OffboardingActivities;
  noAccountTargets: NoAccountTargetActivities;
}): Record<string, unknown> {
  const {
    hr,
    identity,
    entra,
    bulk,
    rateLimiter,
    distributedTx,
    reconciliation,
    policy,
    config,
    accessReview,
    accessReviewRevocation,
    writeback,
    pipeline,
    scheduledSync,
    archival,
    entitlementExpiry,
    privilegedAccess,
    accessRequest,
    riskScore,
    recertification,
    orphan,
    intelligence,
    auditArchive,
    credential,
    mover,
    credentialRotation,
    github,
    serviceNow,
    offboarding,
    noAccountTargets,
  } = context;
  return {
    getActiveTargetSystems: config.getActiveTargetSystems.bind(config),
    getConnectorConfig: config.getConnectorConfig.bind(config),
    getEdgeConditions: config.getEdgeConditions.bind(config),
    fetchNewHires: hr.fetchNewHires.bind(hr),
    saveToHub: identity.saveToHub.bind(identity),
    getUserByEmail: identity.getUserByEmail.bind(identity),
    getIdentityByEmail: identity.getIdentityByEmail.bind(identity),
    getProvisionedTargets: identity.getProvisionedTargets.bind(identity),
    getOffboardingTargets: identity.getOffboardingTargets.bind(identity),
    setProvisioningStatus: identity.setProvisioningStatus.bind(identity),
    recordOnboardingBlocked: identity.recordOnboardingBlocked.bind(identity),
    recordAdminAccountFailed: identity.recordAdminAccountFailed.bind(identity),
    markDeleted: identity.markDeleted.bind(identity),
    suspendIdentity: identity.suspendIdentity.bind(identity),
    recordOffboardingOutcome: offboarding.recordOffboardingOutcome.bind(offboarding),
    // GitHub and ServiceNow have no task queue of their own (connector manifests)
    deprovisionGitHubUser: github.deprovisionGitHubUser.bind(github),
    deprovisionServiceNowUser: serviceNow.deprovisionServiceNowUser.bind(serviceNow),
    ...defaultQueueTargetActivities({ github, serviceNow, noAccountTargets }),
    checkEntraHealth: entra.checkEntraHealth.bind(entra),
    provisionUserToEntra: entra.provisionUserToEntra.bind(entra),
    disableEntraUser: entra.disableEntraUser.bind(entra),
    deleteUser: entra.deleteUser.bind(entra),
    discoverEntitlements: entra.discoverEntitlements.bind(entra),
    validateUpn: entra.validateUpn.bind(entra),
    validateBulkUpns: entra.validateBulkUpns.bind(entra),
    resolveUpnForUser: entra.resolveUpnForUser.bind(entra),
    validateBatch: bulk.validateBatch.bind(bulk),
    partitionOperations: bulk.partitionOperations.bind(bulk),
    executeOperation: bulk.executeOperation.bind(bulk),
    executeSystemOperation: bulk.executeSystemOperation.bind(bulk),
    rollbackOperation: bulk.rollbackOperation.bind(bulk),
    compensateOperation: bulk.compensateOperation.bind(bulk),
    markRemovedAccounts: bulk.markRemovedAccounts.bind(bulk),
    saveToHubWithSnapshot: bulk.saveToHubWithSnapshot.bind(bulk),
    initializeRateLimit: rateLimiter.initializeRateLimit.bind(rateLimiter),
    checkAndWait: rateLimiter.checkAndWait.bind(rateLimiter),
    recordApiCalls: rateLimiter.recordApiCalls.bind(rateLimiter),
    getRateLimitState: rateLimiter.getRateLimitState.bind(rateLimiter),
    getRecommendedBatchSize: rateLimiter.getRecommendedBatchSize.bind(rateLimiter),
    getAllRateLimitStates: rateLimiter.getAllRateLimitStates.bind(rateLimiter),
    resetRateLimits: rateLimiter.resetRateLimits.bind(rateLimiter),
    updateFromExternalSignal: rateLimiter.updateFromExternalSignal.bind(rateLimiter),
    estimateBatchDuration: rateLimiter.estimateBatchDuration.bind(rateLimiter),
    prepareTransaction: distributedTx.prepareTransaction.bind(distributedTx),
    commitTransaction: distributedTx.commitTransaction.bind(distributedTx),
    rollbackTransaction: distributedTx.rollbackTransaction.bind(distributedTx),
    evaluateUser: policy.evaluateUser.bind(policy),
    getReviewExcludedTargets: policy.getReviewExcludedTargets.bind(policy),
    fetchHubUsersPage: reconciliation.fetchHubUsersPage.bind(reconciliation),
    fetchHubUserForReconciliation:
      reconciliation.fetchHubUserForReconciliation.bind(reconciliation),
    getReconciliationUserCount: reconciliation.getReconciliationUserCount.bind(reconciliation),
    getWorkflowStartTime: reconciliation.getWorkflowStartTime.bind(reconciliation),
    getReconciliationBatchConfig: reconciliation.getReconciliationBatchConfig.bind(reconciliation),
    getReconciliationBatchPlan: reconciliation.getReconciliationBatchPlan.bind(reconciliation),
    detectUserDrift: reconciliation.detectUserDrift.bind(reconciliation),
    correctDrift: reconciliation.correctDrift.bind(reconciliation),
    generateReport: reconciliation.generateReport.bind(reconciliation),
    runOrphanDetection: reconciliation.runOrphanDetection.bind(reconciliation),
    updateDriftWorkflowId: reconciliation.updateDriftWorkflowId.bind(reconciliation),
    notifyDriftThresholdExceeded: reconciliation.notifyDriftThresholdExceeded.bind(reconciliation),
    expirePendingItems: accessReview.expirePendingItems.bind(accessReview),
    executeRevocations: accessReview.executeRevocations.bind(accessReview),
    completeCampaign: accessReview.completeCampaign.bind(accessReview),
    getRemainingMsUntilDeadline: accessReview.getRemainingMsUntilDeadline.bind(accessReview),
    getCampaignProgress: accessReview.getCampaignProgress.bind(accessReview),
    checkAndEscalateOverdue: accessReview.checkAndEscalateOverdue.bind(accessReview),
    // revokeReviewAccess runs on the connector queues (worker.ts); account items run here
    listRevocationTasks: accessReviewRevocation.listRevocationTasks.bind(accessReviewRevocation),
    recordRevocationResults:
      accessReviewRevocation.recordRevocationResults.bind(accessReviewRevocation),
    revokeReviewAccount: accessReviewRevocation.revokeReviewAccount.bind(accessReviewRevocation),
    writebackToIdentity: writeback.writebackToIdentity.bind(writeback),
    writebackToHrSource: writeback.writebackToHrSource.bind(writeback),
    getPipelineStatus: pipeline.getPipelineStatus.bind(pipeline),
    recordProvisioningOutcome: pipeline.recordProvisioningOutcome.bind(pipeline),
    runScheduledSync: scheduledSync.runScheduledSync.bind(scheduledSync),
    listArchivalTenantIds: archival.listArchivalTenantIds.bind(archival),
    findDocumentsForArchival: archival.findDocumentsForArchival.bind(archival),
    findArchivalBatch: archival.findArchivalBatch.bind(archival),
    exportArchivalBatch: archival.exportArchivalBatch.bind(archival),
    computeDateRange: archival.computeDateRange.bind(archival),
    exportBatchToStorage: archival.exportBatchToStorage.bind(archival),
    deleteArchivedBatch: archival.deleteArchivedBatch.bind(archival),
    recordArchivalMetadata: archival.recordArchivalMetadata.bind(archival),
    runEntitlementExpiryCheck: entitlementExpiry.runEntitlementExpiryCheck.bind(entitlementExpiry),
    getOrCreateLinkedAdminIdentity:
      privilegedAccess.getOrCreateLinkedAdminIdentity.bind(privilegedAccess),
    getLinkedAdminIdentities: privilegedAccess.getLinkedAdminIdentities.bind(privilegedAccess),
    getPrivilegedSessionTargets:
      privilegedAccess.getPrivilegedSessionTargets.bind(privilegedAccess),
    markPrivilegedSessionActivating:
      privilegedAccess.markPrivilegedSessionActivating.bind(privilegedAccess),
    recordPrivilegedSessionActive:
      privilegedAccess.recordPrivilegedSessionActive.bind(privilegedAccess),
    recordPrivilegedSessionFailed:
      privilegedAccess.recordPrivilegedSessionFailed.bind(privilegedAccess),
    recordPrivilegedSessionEnded:
      privilegedAccess.recordPrivilegedSessionEnded.bind(privilegedAccess),
    settleAdminAccountState: privilegedAccess.settleAdminAccountState.bind(privilegedAccess),
    getAccessRequest: accessRequest.getAccessRequest.bind(accessRequest),
    updateRequestStatus: accessRequest.updateRequestStatus.bind(accessRequest),
    notifyApprover: accessRequest.notifyApprover.bind(accessRequest),
    recheckSodBeforeProvisioning: accessRequest.recheckSodBeforeProvisioning.bind(accessRequest),
    provisionAccessRequest: accessRequest.provisionAccessRequest.bind(accessRequest),
    revokeAccessRequest: accessRequest.revokeAccessRequest.bind(accessRequest),
    expireBeforeFulfilment: accessRequest.expireBeforeFulfilment.bind(accessRequest),
    runRiskScoreBatch: riskScore.runRiskScoreBatch.bind(riskScore),
    listRiskScoreTenants: riskScore.listRiskScoreTenants.bind(riskScore),
    runRiskScoreTenant: riskScore.runRiskScoreTenant.bind(riskScore),
    runRecertificationScheduler: recertification.runRecertificationScheduler.bind(recertification),
    getOrphanConfig: orphan.getOrphanConfig.bind(orphan),
    emitOrphanDetected: orphan.emitOrphanDetected.bind(orphan),
    disableOrphanAccount: orphan.disableOrphanAccount.bind(orphan),
    deleteOrphanAccount: orphan.deleteOrphanAccount.bind(orphan),
    keepOrphanAccount: orphan.keepOrphanAccount.bind(orphan),
    adoptOrphanAccount: orphan.adoptOrphanAccount.bind(orphan),
    updateOrphanDriftStatus: orphan.updateOrphanDriftStatus.bind(orphan),
    setOrphanDisabledAt: orphan.setOrphanDisabledAt.bind(orphan),
    confirmOrphan: orphan.confirmOrphan.bind(orphan),
    runPeerGroupBuild: intelligence.runPeerGroupBuild.bind(intelligence),
    runReviewerQualityScoring: intelligence.runReviewerQualityScoring.bind(intelligence),
    getUnarchivedCheckpoints: auditArchive.getUnarchivedCheckpoints.bind(auditArchive),
    exportCheckpoint: auditArchive.exportCheckpoint.bind(auditArchive),
    getEntraCredentialState: credential.getEntraCredentialState.bind(credential),
    getAdCredentialState: credential.getAdCredentialState.bind(credential),
    getEntraMfaStatus: credential.getEntraMfaStatus.bind(credential),
    evaluateMoverChange: mover.evaluateMoverChange.bind(mover),
    // applyMoverAccess runs on the connector queues (worker.ts); runs from before the patch
    // mover:identity-by-id still call computeEntitlementDelta and the email and profile activities
    computeEntitlementDelta: mover.computeEntitlementDelta.bind(mover),
    recordMoverOutcome: mover.recordMoverOutcome.bind(mover),
    listCredentialRotationTenants:
      credentialRotation.listCredentialRotationTenants.bind(credentialRotation),
    runCredentialRotationBatch:
      credentialRotation.runCredentialRotationBatch.bind(credentialRotation),
  };
}
