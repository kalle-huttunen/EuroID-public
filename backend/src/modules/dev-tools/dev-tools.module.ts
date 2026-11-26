/**
 * Dev Tools Module
 *
 * Provides workflow execution tracking and transaction logging
 * for the Developer Tools pages (Workflow Debugger, Transaction Viewer).
 */

import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DevToolsController } from './dev-tools.controller';
import { DevToolsService } from './dev-tools.service';
import { DevToolsGuard } from './dev-tools.guard';
import { TransactionLog, TransactionLogSchema } from './schemas/transaction-log.schema';

@Global() // Allow other modules to inject DevToolsService without importing
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: TransactionLog.name, schema: TransactionLogSchema },
    ]),
  ],
  controllers: [DevToolsController],
  providers: [DevToolsService, DevToolsGuard],
  exports: [DevToolsService],
})
export class DevToolsModule {}
