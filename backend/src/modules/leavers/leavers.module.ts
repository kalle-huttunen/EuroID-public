import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { LeaverPolicy, LeaverPolicySchema } from './schemas/leaver-policy.schema';
import { LeaverEvent, LeaverEventSchema } from './schemas/leaver-event.schema';
import { LeaverBatch, LeaverBatchSchema } from './schemas/leaver-batch.schema';
import { HrSyncRun, HrSyncRunSchema } from './schemas/hr-sync-run.schema';
import { OffboardingRecord, OffboardingRecordSchema } from './schemas/offboarding-record.schema';
import { LeaverPolicyService } from './leaver-policy.service';
import { LeaverDetectionService } from './leaver-detection.service';
import { LeaverExecutionService } from './leaver-execution.service';
import { LeaverBatchService } from './leaver-batch.service';
import { LeaverSyncHandler } from './leaver-sync.handler';
import { LeaverOffboardingResultHandler } from './leaver-offboarding-result.handler';
import { LeaverManualRemovalService } from './leaver-manual-removal.service';
import { LeaversController } from './leavers.controller';

/**
 * HR-driven leavers: detects leavers after each HR sync and starts their offboarding through
 * IDENTITY_OFFBOARD_REQUESTED, pausing mass-leaver runs for approval. See docs/ARCHITECTURE.md.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Identity.name, schema: IdentitySchema },
      { name: LeaverPolicy.name, schema: LeaverPolicySchema },
      { name: LeaverEvent.name, schema: LeaverEventSchema },
      { name: LeaverBatch.name, schema: LeaverBatchSchema },
      { name: HrSyncRun.name, schema: HrSyncRunSchema },
      { name: OffboardingRecord.name, schema: OffboardingRecordSchema },
    ]),
  ],
  controllers: [LeaversController],
  providers: [
    LeaverPolicyService,
    LeaverDetectionService,
    LeaverExecutionService,
    LeaverBatchService,
    LeaverSyncHandler,
    LeaverOffboardingResultHandler,
    LeaverManualRemovalService,
  ],
  // HR joiners read the time zone and "left" status words (modules/joiners).
  exports: [LeaverPolicyService],
})
export class LeaversModule {}
