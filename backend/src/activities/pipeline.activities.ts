/**
 * Pipeline Activities
 *
 * Temporal activities for pipeline status checks and circuit breaker recording.
 * Used by the onboarding workflow to respect pipeline pause and record outcomes.
 */
import { Injectable } from '@nestjs/common';
import { PipelineService } from '../modules/blueprints/pipeline.service';
import { CircuitBreakerService } from '../modules/blueprints/circuit-breaker.service';
import { PipelineStatus } from '../modules/blueprints/schemas/blueprint.schema';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';

@Injectable()
export class PipelineActivities {
  constructor(
    private readonly pipelineService: PipelineService,
    private readonly circuitBreakerService: CircuitBreakerService,
  ) {}

  async getPipelineStatus(tenantId: string, correlationId?: string): Promise<PipelineStatus> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        return this.pipelineService.getPipelineStatus(tenantId);
      },
      { correlationId },
    );
  }

  async recordProvisioningOutcome(
    tenantId: string,
    success: boolean,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        await this.circuitBreakerService.recordOutcome(tenantId, success);
      },
      { correlationId },
    );
  }
}
