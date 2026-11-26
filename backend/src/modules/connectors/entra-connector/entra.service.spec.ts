/**
 * EntraService.isConfiguredFor: whether a call with a given caller config (a canvas config, or
 * none) has an Entra ID config to run on. It must answer from the same pick every call makes
 * (the caller's config, else the tenant's installed connector config, else ENTRA_*), so
 * onboarding leaves Entra ID out of a run exactly when a call would find no config anywhere, and
 * never for a config the call would use and reject as incomplete.
 */
import type { ConfigService } from '@nestjs/config';
import { EntraService } from './entra.service';
import { EntraClient } from './entra.client';
import { EntraDiscoveryService } from './entra-discovery.service';
import { EntraTenantConfigService } from './entra-tenant-config.service';
import type { EntraConfig } from './entra.interface';
import {
  CorrelationConfigRegistry,
  CONNECTOR_CONFIG_PROVIDER_KEY,
} from '../../correlation-config/correlation-config.registry';
import type { IConnectorConfigProvider } from '../../correlation-config/correlation-config.interface';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';

const ENV = {
  ENTRA_TENANT_ID: 'entra-tenant-env',
  ENTRA_CLIENT_ID: 'app-env',
  ENTRA_CLIENT_SECRET: 'secret-env',
};
const INSTALLED = { tenantId: 'entra-t1', clientId: 'app-t1', clientSecret: 'secret-t1' };
const CANVAS: EntraConfig = { tenantId: 'entra-canvas', clientId: 'app-c', clientSecret: 's-c' };

interface Setup {
  /** The tenant's installed Entra ID connector config; undefined: none installed. */
  installed?: Record<string, string>;
  env?: Record<string, string>;
}

function setup({ installed, env = {} }: Setup) {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const registry = new CorrelationConfigRegistry();
  registry.register(CONNECTOR_CONFIG_PROVIDER_KEY, {
    getConfig: async (name: string) =>
      name === 'entra-id' && installed ? { config: installed } : null,
  } as unknown as IConnectorConfigProvider);
  const tenantConfig = new EntraTenantConfigService(registry);
  // The client only checks credentials here (credentialScope): no token request, no Graph call
  const client = new EntraClient(config, {} as never, {} as never);
  const service = new EntraService(
    new EntraDiscoveryService(client, config),
    {} as never,
    {} as never,
    client,
    tenantConfig,
  );
  /** The credentials check every Graph call runs on the config the call picked. */
  const credentialsOf = async (caller: EntraConfig | undefined) =>
    client.credentialScope(await tenantConfig.resolve(caller));
  return { service, credentialsOf };
}

const inTenant = <T>(fn: () => Promise<T>) => withTenantContext('t1', fn);

describe('EntraService.isConfiguredFor', () => {
  it('is false when nothing is configured: no caller config, none installed, no ENTRA_*', async () => {
    const { service, credentialsOf } = setup({});

    await expect(inTenant(() => service.isConfiguredFor(undefined))).resolves.toBe(false);
    // The same pick finds no config for a call either
    await expect(inTenant(() => credentialsOf(undefined))).rejects.toThrow('Missing Entra Config');
  });

  it('is false when ENTRA_* is only partly set, as a call reads it as missing', async () => {
    const { service, credentialsOf } = setup({ env: { ENTRA_TENANT_ID: 'entra-tenant-env' } });

    await expect(inTenant(() => service.isConfiguredFor(undefined))).resolves.toBe(false);
    await expect(inTenant(() => credentialsOf(undefined))).rejects.toThrow('Missing Entra Config');
  });

  it('is true with ENTRA_* only', async () => {
    const { service, credentialsOf } = setup({ env: ENV });

    await expect(inTenant(() => service.isConfiguredFor(undefined))).resolves.toBe(true);
    await expect(inTenant(() => credentialsOf(undefined))).resolves.toContain('entra-tenant-env');
  });

  it("is true with the tenant's complete installed connector config", async () => {
    const { service, credentialsOf } = setup({ installed: INSTALLED });

    await expect(inTenant(() => service.isConfiguredFor(undefined))).resolves.toBe(true);
    await expect(inTenant(() => credentialsOf(undefined))).resolves.toContain('entra-t1');
  });

  it('is true with an incomplete installed config, so its configuration error stays an error', async () => {
    const { service, credentialsOf } = setup({
      installed: { tenantId: 'entra-t1', clientId: 'app-t1' },
      env: ENV,
    });

    await expect(inTenant(() => service.isConfiguredFor(undefined))).resolves.toBe(true);
    // A call uses the installed config and rejects it, never falling back to ENTRA_*
    await expect(inTenant(() => credentialsOf(undefined))).rejects.toThrow(
      'Entra ID config is incomplete (empty: clientSecret)',
    );
  });

  it('is true with a canvas config that has credentials, without any other config', async () => {
    const { service, credentialsOf } = setup({});

    await expect(inTenant(() => service.isConfiguredFor(CANVAS))).resolves.toBe(true);
    await expect(inTenant(() => credentialsOf(CANVAS))).resolves.toContain('entra-canvas');
  });

  it('is true with an empty canvas config object: a call uses it and rejects it as incomplete', async () => {
    const empty = {} as EntraConfig;
    const { service, credentialsOf } = setup({});

    await expect(inTenant(() => service.isConfiguredFor(empty))).resolves.toBe(true);
    await expect(inTenant(() => credentialsOf(empty))).rejects.toThrow(
      'Entra ID config is incomplete (empty: tenantId, clientId, clientSecret)',
    );
  });

  it('keeps an empty canvas config as the config even when the tenant has installed one', async () => {
    const empty = {} as EntraConfig;
    const { service, credentialsOf } = setup({ installed: INSTALLED, env: ENV });

    await expect(inTenant(() => service.isConfiguredFor(empty))).resolves.toBe(true);
    await expect(inTenant(() => credentialsOf(empty))).rejects.toThrow('incomplete');
  });

  it('isConfiguredForTenant answers like isConfiguredFor without a caller config', async () => {
    for (const s of [{}, { env: ENV }, { installed: INSTALLED }]) {
      const { service } = setup(s);
      await expect(inTenant(() => service.isConfiguredForTenant())).resolves.toBe(
        await inTenant(() => service.isConfiguredFor(undefined)),
      );
    }
  });
});

describe('EntraService.tenantConfigSource (what the diagnostics describe)', () => {
  it.each([
    ['none', {}],
    ['environment', { env: ENV }],
    // The installed config wins over ENTRA_*, also when it is incomplete
    ['tenant-connector', { installed: INSTALLED, env: ENV }],
    ['tenant-connector', { installed: { tenantId: 'entra-t1' } }],
  ] as const)(
    'names %s for %j, the config calls without one of their own run on',
    async (source, s) => {
      const { service } = setup(s);
      await expect(inTenant(() => service.tenantConfigSource())).resolves.toBe(source);
      await expect(inTenant(() => service.isConfiguredForTenant())).resolves.toBe(
        source !== 'none',
      );
    },
  );
});
