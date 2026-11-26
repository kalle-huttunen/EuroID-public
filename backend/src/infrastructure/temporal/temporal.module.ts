import { Global, Module } from '@nestjs/common';
import { TemporalClientProvider } from './temporal-client.provider';

@Global()
@Module({
  providers: [TemporalClientProvider],
  exports: [TemporalClientProvider],
})
export class TemporalModule {}
