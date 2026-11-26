import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  CorrelationConfigRegistry,
  BLUEPRINTS_PROVIDER_KEY,
} from '../correlation-config/correlation-config.registry';
import { BlueprintsService } from './blueprints.service';

/**
 * Registers BlueprintsService with CorrelationConfigRegistry on module init.
 * Enables IdentityModule to resolve config without importing BlueprintsModule.
 */
@Injectable()
export class BlueprintsRegistryProvider implements OnModuleInit {
  constructor(
    private readonly registry: CorrelationConfigRegistry,
    private readonly blueprintsService: BlueprintsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(BLUEPRINTS_PROVIDER_KEY, this.blueprintsService);
  }
}
