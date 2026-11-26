/**
 * Risk Score Calculation Activities
 *
 * Temporal activities for nightly risk score batch calculation.
 */

import { Injectable, Logger } from '@nestjs/common';
import { RiskScoringService } from '../modules/risk-scoring/risk-scoring.service';
import { TenantService } from '../infrastructure/multi-tenancy/tenant.service';
import { DomainEventEmitterService } from '../infrastructure/events/event-emitter.service';
import { DomainEventType } from '../infrastructure/events/event-types';
import { withTenantContext } from '../infrastructure/multi-tenancy/tenant-context.helper';
import type { RiskBatchProgress } from '../modules/risk-scoring/risk-scoring.service';
import { heartbeat, lastHeartbeat } from './activity-heartbeat';

export interface RiskScoreBatchResult {
  processed: number;
  errors: number;
}

export interface RiskScoresCalculatedSummary {
  tenantId: string;
  processed: number;
  errors: number;
  /** The tenant's average risk score (every identity's, one decimal). */
  avgScore?: number;
  top10IdentityIds?: string[];
}

const BATCH_SIZE = 100;

@Injectable()
export class RiskScoreActivities {
  private readonly logger = new Logger(RiskScoreActivities.name);

  constructor(
    private readonly riskScoringService: RiskScoringService,
    private readonly tenantService: TenantService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** The tenants a nightly run scores: the one it names, else every active tenant. */
  async listRiskScoreTenants(tenantId: string): Promise<string[]> {
    if (tenantId) return [tenantId];
    return (await this.tenantService.findAll())
      .filter((t) => t.status === 'active')
      .map((t) => t.tenantId);
  }

  /**
   * Score one tenant (workflow patch risk-score-calculation:per-tenant). The batch's progress is
   * heartbeated after every identity; a retried attempt resumes from the last heartbeat with its
   * counts. A failure is thrown for Temporal to retry; the workflow counts a tenant that fails
   * for good as one error. Emits risk_scores.calculated for the tenant, as runRiskScoreBatch.
   */
  async runRiskScoreTenant(
    tenantId: string,
    nowIso: string,
    batchSize: number,
  ): Promise<RiskScoreBatchResult> {
    const resume = lastHeartbeat<RiskBatchProgress>();
    if (resume) {
      this.logger.log(`[RiskScore] Tenant ${tenantId}: resuming at identity ${resume.offset}`);
    }
    const result = await withTenantContext(tenantId, () =>
      this.riskScoringService.batchCalculate(tenantId, batchSize, new Date(nowIso), {
        resume,
        onProgress: (state) => heartbeat(state),
      }),
    );
    await this.reportCalculated(tenantId, result);
    return { processed: result.processed, errors: result.errors };
  }

  /** risk_scores.calculated for a tenant that had anything scored or failed. */
  private async reportCalculated(tid: string, result: RiskScoreBatchResult): Promise<void> {
    if (result.processed === 0 && result.errors === 0) return;
    const topRisky = await withTenantContext(tid, () =>
      this.riskScoringService.getTopRisky(tid, 10),
    );
    // Every score of the tenant, not the ten riskiest ones only
    const avgScore = await withTenantContext(tid, () =>
      this.riskScoringService.getAverageScore(tid),
    );
    this.eventEmitter.emit(DomainEventType.RISK_SCORES_CALCULATED, tid, {
      tenantId: tid,
      processed: result.processed,
      errors: result.errors,
      avgScore,
      top10IdentityIds: topRisky.slice(0, 10).map((r) => r.identityId),
    });
  }

  /**
   * Run risk score batch calculation for a tenant (or all tenants when tenantId is empty), in one
   * activity: only histories from before the patch risk-score-calculation:per-tenant call it.
   */
  async runRiskScoreBatch(
    tenantId: string,
    nowIso: string,
    batchSize?: number,
  ): Promise<RiskScoreBatchResult> {
    const now = new Date(nowIso);
    const size = batchSize ?? BATCH_SIZE;

    const tenants = (await this.listRiskScoreTenants(tenantId)).map((tid) => ({ tenantId: tid }));

    let totalProcessed = 0;
    let totalErrors = 0;

    for (const { tenantId: tid } of tenants) {
      try {
        const result = await withTenantContext(tid, () =>
          this.riskScoringService.batchCalculate(tid, size, now),
        );
        totalProcessed += result.processed;
        totalErrors += result.errors;
        await this.reportCalculated(tid, result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[RiskScore] Batch failed for tenant ${tid}: ${msg}`);
        totalErrors += 1;
      }
    }

    return { processed: totalProcessed, errors: totalErrors };
  }
}
