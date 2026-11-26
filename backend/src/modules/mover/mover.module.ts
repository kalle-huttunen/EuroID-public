import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MoverService } from './mover.service';
import { AccessReevaluationService } from './access-reevaluation.service';
import { AccessReevaluationController } from './access-reevaluation.controller';
import { ReviewExclusionLiftService } from './review-exclusion-lift.service';
import { ReviewExclusionLiftController } from './review-exclusion-lift.controller';
import { MoverEventHandler } from '../../infrastructure/events/handlers/mover.handler';
import { MoverTimelineHandler } from '../../infrastructure/events/handlers/mover-timeline.handler';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { LeaverEvent, LeaverEventSchema } from '../leavers/schemas/leaver-event.schema';
import { MoverPolicy, MoverPolicySchema } from './schemas/mover-policy.schema';
import {
  AccessRequest,
  AccessRequestSchema,
} from '../access-requests/schemas/access-request.schema';
import { MoverBatch, MoverBatchSchema } from './schemas/mover-batch.schema';
import { MoverBatchItem, MoverBatchItemSchema } from './schemas/mover-batch-item.schema';
import { HrMoverPolicyService } from './hr-mover-policy.service';
import { HrMoverExecutionService } from './hr-mover-execution.service';
import { HrMoverDetectionService } from './hr-mover-detection.service';
import { HrMoverBatchService } from './hr-mover-batch.service';
import { HrMoverSyncHandler } from './hr-mover-sync.handler';
import { HrMoversController } from './hr-movers.controller';

/**
 * Mover: access changes for provisioned identities. Starts the mover workflow on an attribute
 * change (MoverEventHandler), an operator's re-evaluation (AccessReevaluationController, which
 * also previews it) or an HR sync that moved someone (HrMoverSyncHandler, pausing mass changes
 * for approval: HrMoversController), and puts mover runs on the identity timeline
 * (MoverTimelineHandler). Lifting an access review exclusion starts the same re-evaluation
 * (ReviewExclusionLiftController). See docs/ARCHITECTURE.md.
 */
@Module({
  imports: [
    IdentityModule,
    PolicyModule, // POLICY_DECISION_PORT for the preview, ReviewExclusionService for the lift
    MongooseModule.forFeature([
      { name: Identity.name, schema: IdentitySchema },
      // Read only: identities an HR leaver is offboarding get no HR mover run.
      { name: LeaverEvent.name, schema: LeaverEventSchema },
      // Read only: the access preview keeps what an active access request grants.
      { name: AccessRequest.name, schema: AccessRequestSchema },
      { name: MoverPolicy.name, schema: MoverPolicySchema },
      { name: MoverBatch.name, schema: MoverBatchSchema },
      { name: MoverBatchItem.name, schema: MoverBatchItemSchema },
    ]),
  ],
  controllers: [AccessReevaluationController, HrMoversController, ReviewExclusionLiftController],
  providers: [
    MoverService,
    AccessReevaluationService,
    ReviewExclusionLiftService,
    MoverEventHandler,
    MoverTimelineHandler,
    HrMoverPolicyService,
    HrMoverExecutionService,
    HrMoverDetectionService,
    HrMoverBatchService,
    HrMoverSyncHandler,
  ],
  exports: [MoverService],
})
export class MoverModule {}
