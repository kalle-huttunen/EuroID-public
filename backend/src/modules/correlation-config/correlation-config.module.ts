import { Module } from '@nestjs/common';
import { CorrelationConfigRegistry } from './correlation-config.registry';
import { CorrelationConfigService } from './correlation-config.service';

/**
 * Provides unified config for identity correlation and reconciliation.
 * Blueprints and ConnectorConfig register their providers on init.
 * IdentityModule imports this instead of those modules to break circular deps.
 */
@Module({
  providers: [CorrelationConfigRegistry, CorrelationConfigService],
  exports: [CorrelationConfigRegistry, CorrelationConfigService],
})
export class CorrelationConfigModule {}
