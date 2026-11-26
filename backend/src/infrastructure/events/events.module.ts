import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DomainEventEmitterService } from './event-emitter.service';
import { OutboxPollerService } from './outbox-poller.service';
import { HandlerFailureCaptureService } from './handler-failure-capture.service';
import { OutboxEvent, OutboxEventSchema } from './schemas/outbox-event.schema';
import { AuditEventHandler } from './handlers/audit-event.handler';
import { MetricsEventHandler } from './handlers/metrics-event.handler';
import { AuditModule } from '../../modules/audit/audit.module';
import { DeadLetterModule } from '../../modules/dead-letter/dead-letter.module';
import { DOMAIN_EVENT_PORT } from '@shared/interfaces/domain-event.port';

/**
 * Global domain event infrastructure. Provides typed event emission via DomainEventEmitterService.
 *
 * Infrastructure-level handlers live here: Audit (wildcard), Metrics (provisioning/drift/policy).
 * Domain-specific handlers are registered by their owning feature modules:
 *   - UserTimelineHandler, LeaverTimelineHandler, OffboardingTimelineHandler,
 *     OffboardingManualRemovalHandler → IdentityModule
 *   - LeaverSyncHandler → LeaversModule
 *   - OnboardingEventHandler, SourcesChangedHandler → OnboardingModule
 *   - OffboardingEventHandler → OffboardingModule
 *   - OffboardImpactEventHandler, IdentityEntitlementsRequestHandler → AccessRequestsModule
 *   - IdentityEntitlementsPolicyHandler, ReviewExclusionOffboardingHandler → PolicyModule
 *   - MoverEventHandler, MoverTimelineHandler, HrMoverSyncHandler → MoverModule
 *   - JoinerSyncHandler, JoinerTimelineHandler → JoinersModule
 *   - EmailNotificationHandler → NotificationsModule
 *   - EntitlementExpiryTimelineHandler → EntitlementExpiryActivitiesModule
 *   - AccessReviewTimelineHandler → AccessReviewModule
 */
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: OutboxEvent.name, schema: OutboxEventSchema }]),
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
      ignoreErrors: false,
    }),
    AuditModule, // AuditService for AuditEventHandler (cross-cutting concern)
    DeadLetterModule, // DLQ capture for failed handlers
    DiscoveryModule, // HandlerFailureCaptureService finds the @OnEvent handlers
  ],
  providers: [
    DomainEventEmitterService,
    OutboxPollerService,
    HandlerFailureCaptureService, // every @OnEvent failure to the DLQ, per handler
    AuditEventHandler,
    MetricsEventHandler,
    { provide: DOMAIN_EVENT_PORT, useExisting: DomainEventEmitterService },
  ],
  exports: [DomainEventEmitterService, DOMAIN_EVENT_PORT],
})
export class EventsModule {}

// ── TASK 106 RECAP ──
// Added: MongooseModule for OutboxEvent, OutboxPollerService provider. DomainEventEmitterService
// now receives OutboxEvent model for emitWithTransaction.
