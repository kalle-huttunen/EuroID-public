/**
 * Which Entra ID config a call without one runs on: the current tenant's installed Entra ID
 * connector config, else undefined (ENTRA_*). The tenant comes from the request context only, so
 * a call outside any tenant context reads no tenant's config.
 */
import { EntraTenantConfigService } from './entra-tenant-config.service';
import type { EntraConfig } from './entra.interface';
import {
  CorrelationConfigRegistry,
  CONNECTOR_CONFIG_PROVIDER_KEY,
} from '../../correlation-config/correlation-config.registry';
import type { IConnectorConfigProvider } from '../../correlation-config/correlation-config.interface';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';

const INSTALLED = { tenantId: 'entra-t1', clientId: 'app-t1', clientSecret: 'secret-t1' };
const CANVAS: EntraConfig = { tenantId: 'entra-canvas', clientId: 'app-c', clientSecret: 's-c' };

function setup(installedByTenant: Record<string, Record<string, string>>) {
  const getConfig = jest.fn(async (name: string) => {
    const config = installedByTenant[getRequestContext()?.tenantId ?? ''];
    return name === 'entra-id' && config ? { config } : null;
  });
  const registry = new CorrelationConfigRegistry();
  registry.register(CONNECTOR_CONFIG_PROVIDER_KEY, {
    getConfig,
  } as unknown as IConnectorConfigProvider);
  return { service: new EntraTenantConfigService(registry), getConfig };
}

describe('EntraTenantConfigService', () => {
  it("runs a call without a config on its tenant's installed Entra ID config", async () => {
    const { service, getConfig } = setup({ t1: INSTALLED });

    await expect(withTenantContext('t1', () => service.resolve(undefined))).resolves.toEqual(
      INSTALLED,
    );
    expect(getConfig).toHaveBeenCalledWith('entra-id');
  });

  it('falls back to ENTRA_* (undefined) only for a tenant that has installed none', async () => {
    const { service } = setup({ t1: INSTALLED });

    await expect(
      withTenantContext('t2', () => service.resolve(undefined)),
    ).resolves.toBeUndefined();
  });

  it("keeps the caller's canvas config without reading the installed one", async () => {
    const { service, getConfig } = setup({ t1: INSTALLED });

    await expect(withTenantContext('t1', () => service.resolve(CANVAS))).resolves.toBe(CANVAS);
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("reads no tenant's config outside a tenant context", async () => {
    const { service, getConfig } = setup({ default: INSTALLED, '': INSTALLED });

    await expect(service.resolve(undefined)).resolves.toBeUndefined();
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('hands an incomplete installed config on as it is, for EntraClient to reject', async () => {
    const { service } = setup({ t1: { tenantId: 'entra-t1', clientId: 'app-t1' } });

    await expect(withTenantContext('t1', () => service.installed())).resolves.toEqual({
      tenantId: 'entra-t1',
      clientId: 'app-t1',
    });
  });

  it('reads nothing when no connector config provider is registered (ENTRA_*)', async () => {
    const service = new EntraTenantConfigService(new CorrelationConfigRegistry());

    await expect(withTenantContext('t1', () => service.installed())).resolves.toBeUndefined();
  });
});
