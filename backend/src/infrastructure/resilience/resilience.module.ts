import { Global, Module } from '@nestjs/common';
import { ConnectorCircuitBreakerService } from './connector-circuit-breaker';

@Global()
@Module({
  providers: [ConnectorCircuitBreakerService],
  exports: [ConnectorCircuitBreakerService],
})
export class ResilienceModule {}
