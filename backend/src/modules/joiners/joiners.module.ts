import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { IdentityModule } from '../identity/identity.module';
import { BlueprintsModule } from '../blueprints/blueprints.module';
import { LeaversModule } from '../leavers/leavers.module';
import { LeaverEvent, LeaverEventSchema } from '../leavers/schemas/leaver-event.schema';
import { JoinerTimelineHandler } from '../../infrastructure/events/handlers/joiner-timeline.handler';
import { JoinerPolicy, JoinerPolicySchema } from './schemas/joiner-policy.schema';
import { JoinerEvent, JoinerEventSchema } from './schemas/joiner-event.schema';
import { JoinerBatch, JoinerBatchSchema } from './schemas/joiner-batch.schema';
import { JoinerSource, JoinerSourceSchema } from './schemas/joiner-source.schema';
import { JoinerPolicyService } from './joiner-policy.service';
import { JoinerExecutionService } from './joiner-execution.service';
import { JoinerDetectionService } from './joiner-detection.service';
import { JoinerBatchService } from './joiner-batch.service';
import { JoinerSyncHandler } from './joiner-sync.handler';
import { JoinersController } from './joiners.controller';

/**
 * HR-driven joiners: after each HR sync, the identities it minted are onboarded through
 * IDENTITY_PROVISION_REQUESTED (the existing onboarding workflow) once the tenant's pipeline is
 * deployed, pausing mass joins for approval (JoinersController), and the start goes on the
 * identity timeline (JoinerTimelineHandler). See docs/ARCHITECTURE.md.
 */
@Module({
  imports: [
    IdentityModule, // UserEventService for the timeline
    BlueprintsModule, // PipelineService: joiners start only while the pipeline is DEPLOYED
    LeaversModule, // LeaverPolicyService: time zone and "left" status words
    MongooseModule.forFeature([
      { name: Identity.name, schema: IdentitySchema },
      // Read only: an identity an HR leaver is offboarding is no joiner.
      { name: LeaverEvent.name, schema: LeaverEventSchema },
      { name: JoinerPolicy.name, schema: JoinerPolicySchema },
      { name: JoinerEvent.name, schema: JoinerEventSchema },
      { name: JoinerBatch.name, schema: JoinerBatchSchema },
      { name: JoinerSource.name, schema: JoinerSourceSchema },
    ]),
  ],
  controllers: [JoinersController],
  providers: [
    JoinerPolicyService,
    JoinerExecutionService,
    JoinerDetectionService,
    JoinerBatchService,
    JoinerSyncHandler,
    JoinerTimelineHandler,
  ],
})
export class JoinersModule {}
