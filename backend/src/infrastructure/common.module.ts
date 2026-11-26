/**
 * CommonModule — shared services used across feature modules
 */

import { Global, Module } from '@nestjs/common';
import { CorrelationHashService } from './services/correlation-hash.service';

@Global()
@Module({
  providers: [CorrelationHashService],
  exports: [CorrelationHashService],
})
export class CommonModule {}
