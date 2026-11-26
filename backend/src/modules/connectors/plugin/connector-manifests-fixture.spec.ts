/**
 * test/fixtures/connector-manifests.json is the backend side of the Design studio's connector
 * registry test (frontend/src/features/blueprints/shared/__tests__/connector-registry.test.ts):
 * the connectors registerBuiltInConnectors registers, their icon, their capabilities ('ingest'
 * makes an HR source) and the key, type and required flag of each config field. The frontend
 * checks its registry and its settings forms against this file, and the Marketplace's icon map
 * (frontend/src/features/connectors/__tests__/connector-icons.test.tsx), so a connector or config
 * field added here fails one of those tests until the fixture and the frontend follow.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { ModuleRef } from '@nestjs/core';
import { PluginRegistryService } from './plugin-registry.service';
import { registerBuiltInConnectors } from './register-connectors';

const FIXTURE = resolve(__dirname, '../../../../test/fixtures/connector-manifests.json');

describe('connector manifests fixture', () => {
  it('matches the connectors, icons and config fields the backend registers', () => {
    const registry = new PluginRegistryService({} as ModuleRef);
    registerBuiltInConnectors(registry);

    const registered = registry.getAll().map((m) => ({
      id: m.id,
      icon: m.icon,
      capabilities: m.capabilities,
      configSchema: m.configSchema.map(({ key, type, required }) => ({ key, type, required })),
    }));

    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual({ connectors: registered });
  });
});
