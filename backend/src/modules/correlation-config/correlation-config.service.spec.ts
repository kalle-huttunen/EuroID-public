import { CorrelationConfigService } from './correlation-config.service';
import {
  CorrelationConfigRegistry,
  BLUEPRINTS_PROVIDER_KEY,
  CONNECTOR_CONFIG_PROVIDER_KEY,
} from './correlation-config.registry';
import type {
  IBlueprintConfigProvider,
  IConnectorConfigProvider,
} from './correlation-config.interface';
import { CorrelationConfigUnavailableError } from './correlation-config.errors';

/** A service whose connector provider knows `hrNames` and whose Design Studio canvas is `canvas`. */
function serviceWith(hrNames: string[], canvas: { nodes: unknown[]; connectorConfigs?: object }) {
  const registry = new CorrelationConfigRegistry();
  registry.register(CONNECTOR_CONFIG_PROVIDER_KEY, {
    isHrSourceName: async (name: string) => hrNames.includes(name),
  } as unknown as IConnectorConfigProvider);
  registry.register(BLUEPRINTS_PROVIDER_KEY, {
    getLatestBlueprint: async () => canvas,
  } as unknown as IBlueprintConfigProvider);
  return new CorrelationConfigService(registry);
}

describe('CorrelationConfigService.isHrSourceName', () => {
  it('takes the connector provider answer for an installed or built-in HR connector', async () => {
    const service = serviceWith(['csv-hr'], { nodes: [] });

    expect(await service.isHrSourceName('csv-hr')).toBe(true);
    expect(await service.isHrSourceName('entra-id')).toBe(false);
  });

  it('recognises the sourceSystem of a Design Studio source node, in its config or connectorConfigs', async () => {
    const service = serviceWith([], {
      nodes: [
        {
          id: 'n1',
          data: { role: 'source', type: 'csv-hr', config: { sourceSystem: 'Payroll HR' } },
        },
        { id: 'n2', data: { role: 'source', type: 'json-api-hr' } },
      ],
      connectorConfigs: { 'json-api-hr': { sourceSystem: 'People API' } },
    });

    expect(await service.isHrSourceName('payroll-hr')).toBe(true);
    expect(await service.isHrSourceName('people-api')).toBe(true);
  });

  it('does not take a target node for an HR source', async () => {
    const service = serviceWith([], {
      nodes: [
        { id: 't1', data: { role: 'target', type: 'ad', config: { sourceSystem: 'ad-hr' } } },
      ],
    });

    expect(await service.isHrSourceName('ad')).toBe(false);
    expect(await service.isHrSourceName('ad-hr')).toBe(false);
  });

  it('answers false without registered providers', async () => {
    const service = new CorrelationConfigService(new CorrelationConfigRegistry());

    expect(await service.isHrSourceName('csv-hr')).toBe(false);
  });
});

/**
 * The tenant's correlation settings. Most callers only need the field mastery overrides and may
 * fall back to the default email rule when the blueprint cannot be read. Ingest may not: the
 * settings name the national ID field to remove from every record (identity/national-id.ts), so
 * a fallback would store a custom national ID field raw. Ingest asks with `strict`.
 */
describe('CorrelationConfigService.getCorrelationConfig', () => {
  const rules = [{ strategy: 'hashedNationalId' as const, nationalIdSourceField: 'ssn' }];

  function withBlueprint(read: () => Promise<unknown>) {
    const registry = new CorrelationConfigRegistry();
    registry.register(BLUEPRINTS_PROVIDER_KEY, {
      getLatestBlueprint: read,
    } as unknown as IBlueprintConfigProvider);
    return new CorrelationConfigService(registry);
  }

  it('returns the stored rules, strict or not', async () => {
    const service = withBlueprint(async () => ({
      connectorConfigs: { 'euroid-core': { correlationConfig: { rules } } },
    }));

    await expect(service.getCorrelationConfig('t')).resolves.toMatchObject({ rules });
    await expect(service.getCorrelationConfig('t', { strict: true })).resolves.toMatchObject({
      rules,
    });
  });

  it('falls back to the email rule when the blueprint cannot be read', async () => {
    const service = withBlueprint(async () => {
      throw new Error('MongoServerSelectionError: connection refused');
    });

    await expect(service.getCorrelationConfig('t')).resolves.toMatchObject({
      rules: [{ strategy: 'email' }],
    });
  });

  it('strict: fails instead of falling back when the blueprint cannot be read', async () => {
    const service = withBlueprint(async () => {
      throw new Error('MongoServerSelectionError: connection refused');
    });

    await expect(service.getCorrelationConfig('t', { strict: true })).rejects.toBeInstanceOf(
      CorrelationConfigUnavailableError,
    );
  });

  it('strict: a tenant without settings, or without a blueprint provider, gets the default', async () => {
    await expect(
      withBlueprint(async () => ({ connectorConfigs: {} })).getCorrelationConfig('t', {
        strict: true,
      }),
    ).resolves.toMatchObject({ rules: [{ strategy: 'email' }] });
    await expect(
      new CorrelationConfigService(new CorrelationConfigRegistry()).getCorrelationConfig('t', {
        strict: true,
      }),
    ).resolves.toMatchObject({ rules: [{ strategy: 'email' }] });
  });
});
