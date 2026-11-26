/**
 * Audit Module
 *
 * Provides the AuditService globally so every module can emit audit events
 * without explicitly importing this module.
 */

import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditMerkleService } from './audit-merkle.service';
import { AuditAnchorService } from './audit-anchor.service';
import { AuditArchiveService } from './audit-archive.service';
import { AuditEvent, AuditEventSchema } from './schemas/audit-event.schema';
import { AuditMerkleRoot, AuditMerkleRootSchema } from './schemas/audit-merkle-root.schema';
import { AuditChainHead, AuditChainHeadSchema } from './schemas/audit-chain-head.schema';
import { createAuditArchiveStorageAdapter } from './audit-archive-storage.factory';

@Global() // Makes AuditService injectable everywhere without import
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuditEvent.name, schema: AuditEventSchema },
      { name: AuditMerkleRoot.name, schema: AuditMerkleRootSchema },
      { name: AuditChainHead.name, schema: AuditChainHeadSchema },
    ]),
  ],
  controllers: [AuditController],
  providers: [
    AuditService,
    AuditAnchorService,
    AuditMerkleService,
    {
      provide: 'AUDIT_ARCHIVE_STORAGE',
      useFactory: createAuditArchiveStorageAdapter,
    },
    AuditArchiveService,
  ],
  exports: [AuditService, AuditMerkleService, AuditAnchorService, AuditArchiveService],
})
export class AuditModule {}
