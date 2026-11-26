/**
 * Rollback snapshot store for bulk provisioning activities. EncryptionService comes from the
 * global SecretsModule.
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RollbackSnapshot, RollbackSnapshotSchema } from './schemas/rollback-snapshot.schema';
import { RollbackSnapshotService } from './rollback-snapshot.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: RollbackSnapshot.name, schema: RollbackSnapshotSchema }]),
  ],
  providers: [RollbackSnapshotService],
  exports: [RollbackSnapshotService],
})
export class RollbackSnapshotModule {}
