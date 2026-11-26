/**
 * Bulk Provisioning Module
 *
 * Module for handling bulk user provisioning operations with Temporal workflows.
 */

import { Module } from '@nestjs/common';
import { BulkProvisioningService } from './bulk-provisioning.service';
import { BulkProvisioningController } from './bulk-provisioning.controller';
import { CorrelationConfigModule } from '../correlation-config/correlation-config.module';

@Module({
  // CorrelationConfigModule: the tenant's Hashed National ID rule, removed from the batch's users
  imports: [CorrelationConfigModule],
  providers: [BulkProvisioningService],
  controllers: [BulkProvisioningController],
  exports: [BulkProvisioningService],
})
export class BulkProvisioningModule {}
