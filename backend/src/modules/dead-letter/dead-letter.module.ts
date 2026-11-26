/**
 * Dead Letter Queue Module
 *
 * Captures failed events, workflows, and connector errors. Exports DeadLetterService
 * so other modules can inject it for capturing failures.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { deadLetterConfig } from '@infrastructure/config/dead-letter.config';
import { DeadLetterEntry, DeadLetterEntrySchema } from './schemas/dead-letter.schema';
import { DeadLetterService } from './dead-letter.service';
import { DeadLetterHandlerRegistry } from './dead-letter-handler.registry';
import { DeadLetterController } from './dead-letter.controller';

@Module({
  imports: [
    ConfigModule.forFeature(deadLetterConfig),
    MongooseModule.forFeature([{ name: DeadLetterEntry.name, schema: DeadLetterEntrySchema }]),
  ],
  controllers: [DeadLetterController],
  providers: [DeadLetterService, DeadLetterHandlerRegistry],
  exports: [DeadLetterService, DeadLetterHandlerRegistry],
})
export class DeadLetterModule {}
