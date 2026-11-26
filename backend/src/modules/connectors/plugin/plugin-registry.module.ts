import { Global, Module, OnModuleInit } from '@nestjs/common';
import { PluginRegistryService } from './plugin-registry.service';
import { registerBuiltInConnectors } from './register-connectors';

@Global()
@Module({
  providers: [PluginRegistryService],
  exports: [PluginRegistryService],
})
export class PluginRegistryModule implements OnModuleInit {
  constructor(private readonly registry: PluginRegistryService) {}

  onModuleInit() {
    registerBuiltInConnectors(this.registry);
  }
}
