/**
 * Intelligence Batch Workflow
 *
 * Nightly CronWorkflow that refreshes peer groups and scores reviewer quality.
 * Runs AFTER risk scoring (default 4 AM). Pure workflow: no side effects.
 */

import { proxyActivities, log } from '@temporalio/workflow';
import { SCHEDULED_SYNC_RETRY } from '../infrastructure/config/retry-policies';

export interface IntelligenceBatchInput {
  tenantId?: string;
}

export interface IntelligenceBatchResult {
  groupsBuilt: number;
  campaignsScored: number;
  errors: number;
}

const { runPeerGroupBuild, runReviewerQualityScoring } = proxyActivities<{
  runPeerGroupBuild: (tenantId: string) => Promise<{ groupsBuilt: number; errors: number }>;
  runReviewerQualityScoring: (
    tenantId: string,
  ) => Promise<{ campaignsScored: number; errors: number }>;
}>({
  startToCloseTimeout: '30 minutes',
  retry: SCHEDULED_SYNC_RETRY,
});

export async function intelligenceBatchWorkflow(
  input?: IntelligenceBatchInput,
): Promise<IntelligenceBatchResult> {
  const tenantId = input?.tenantId ?? '';
  log.info('[Intelligence] Starting batch', { tenantId: tenantId || 'all' });

  const peerResult = await runPeerGroupBuild(tenantId);
  log.info('[Intelligence] Peer groups built', {
    groupsBuilt: peerResult.groupsBuilt,
    errors: peerResult.errors,
  });

  const qualityResult = await runReviewerQualityScoring(tenantId);
  log.info('[Intelligence] Reviewer quality scored', {
    campaignsScored: qualityResult.campaignsScored,
    errors: qualityResult.errors,
  });

  const totalErrors = peerResult.errors + qualityResult.errors;
  log.info('[Intelligence] Batch complete', {
    groupsBuilt: peerResult.groupsBuilt,
    campaignsScored: qualityResult.campaignsScored,
    totalErrors,
  });

  return {
    groupsBuilt: peerResult.groupsBuilt,
    campaignsScored: qualityResult.campaignsScored,
    errors: totalErrors,
  };
}
