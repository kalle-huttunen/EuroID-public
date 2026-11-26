/**
 * Circuit Breaker Service
 *
 * Tracks provisioning outcomes and auto-pauses the pipeline when error rate
 * exceeds the configured threshold. Uses a rolling 1-hour window.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ProvisioningMetrics } from './schemas/provisioning-metrics.schema';
import { PipelineService } from './pipeline.service';
import { BlueprintsService } from './blueprints.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EventsGateway } from '@infrastructure/realtime/events.gateway';

const WINDOW_MS = 60 * 60 * 1000; // 1 hour rolling window

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  constructor(
    @InjectModel(ProvisioningMetrics.name)
    private readonly metricsModel: Model<ProvisioningMetrics>,
    private readonly pipelineService: PipelineService,
    private readonly blueprintsService: BlueprintsService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  /**
   * Record a provisioning outcome and check circuit breaker.
   * Uses rolling 1-hour window: if outside window, reset counts.
   */
  async recordOutcome(tenantId: string, success: boolean): Promise<void> {
    const now = new Date();
    const existing = await this.metricsModel.findOne({ tenantId }).exec();

    let doc: ProvisioningMetrics;
    if (!existing) {
      doc = await this.metricsModel.create({
        tenantId,
        windowStart: now,
        totalAttempts: 1,
        successCount: success ? 1 : 0,
        failureCount: success ? 0 : 1,
        errorRate: success ? 0 : 1,
      });
    } else {
      const windowEnd = new Date(existing.windowStart.getTime() + WINDOW_MS);
      if (now > windowEnd) {
        const updated = await this.metricsModel.findOneAndUpdate(
          { tenantId },
          {
            $set: {
              windowStart: now,
              totalAttempts: 1,
              successCount: success ? 1 : 0,
              failureCount: success ? 0 : 1,
              errorRate: success ? 0 : 1,
            },
          },
          { new: true },
        );
        if (!updated) return;
        doc = updated;
      } else {
        const updated = await this.metricsModel.findOneAndUpdate(
          { tenantId },
          {
            $inc: {
              totalAttempts: 1,
              successCount: success ? 1 : 0,
              failureCount: success ? 0 : 1,
            },
          },
          { new: true },
        );
        if (!updated) return;
        doc = updated;
        const errorRate = doc.totalAttempts > 0 ? doc.failureCount / doc.totalAttempts : 0;
        await this.metricsModel.updateOne({ _id: doc._id }, { $set: { errorRate } });
        doc.errorRate = errorRate;
      }
    }

    await this.checkCircuitBreaker(tenantId);
  }

  /**
   * Check if circuit breaker should trip based on error rate.
   */
  async checkCircuitBreaker(tenantId: string): Promise<void> {
    const config = await this.pipelineService.getPipelineConfig(tenantId);
    const status = await this.pipelineService.getPipelineStatus(tenantId);

    if (status !== 'DEPLOYED') return;

    const metrics = await this.metricsModel.findOne({ tenantId }).exec();
    if (!metrics || metrics.totalAttempts < (config.minSampleSizeForCircuitBreaker ?? 5)) return;

    const threshold = (config.errorThresholdPercent ?? 5) / 100;
    if (metrics.errorRate <= threshold) return;

    this.logger.warn(
      `Circuit breaker triggered for tenant ${tenantId}: error rate ${(metrics.errorRate * 100).toFixed(1)}% exceeds ${config.errorThresholdPercent}%`,
    );

    await this.pipelineService.pause(tenantId, 'circuit_breaker');

    const payload = {
      type: 'CIRCUIT_BREAKER_TRIGGERED',
      errorRate: metrics.errorRate,
      threshold: config.errorThresholdPercent,
      message: `Error rate ${(metrics.errorRate * 100).toFixed(1)}% exceeds threshold ${config.errorThresholdPercent}%`,
    };

    this.eventEmitter.emit(DomainEventType.CIRCUIT_BREAKER_TRIGGERED, tenantId, payload, {
      tenantId,
    });

    this.eventsGateway.broadcastToRoom(
      `t:${tenantId}:pipeline`,
      DomainEventType.CIRCUIT_BREAKER_TRIGGERED,
      payload,
    );
  }
}
