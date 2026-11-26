import {
  buildConnectorHealthChecks,
  type ConnectorHealthCheckDeps,
} from './connector-health-checks';
import { registerBuiltInConnectors } from './plugin/register-connectors';
import type { PluginRegistryService } from './plugin/plugin-registry.service';

describe('buildConnectorHealthChecks', () => {
  let deps: { [K in keyof ConnectorHealthCheckDeps]: Record<string, jest.Mock> };

  beforeEach(() => {
    const healthy = () => ({ healthCheck: jest.fn().mockResolvedValue(true) });
    deps = {
      entra: { checkEntraHealth: jest.fn().mockResolvedValue(true) },
      ad: { checkAdHealthEnriched: jest.fn().mockResolvedValue({ connected: false }) },
      scim: { checkScimHealth: jest.fn().mockResolvedValue({ healthy: true }) },
      okta: healthy(),
      serviceNow: healthy(),
      gitHub: healthy(),
      googleSheets: healthy(),
      discordWebhook: healthy(),
      fileOutbound: healthy(),
      csvHr: healthy(),
      jsonApiHr: healthy(),
    };
  });

  const checks = () => buildConnectorHealthChecks(deps as unknown as ConnectorHealthCheckDeps);

  it('has a health check for every built-in connector', () => {
    const ids: string[] = [];
    registerBuiltInConnectors({
      register: (manifest: { id: string }) => ids.push(manifest.id),
    } as unknown as PluginRegistryService);

    expect(Object.keys(checks()).sort()).toEqual(ids.sort());
  });

  it("checks Entra ID with the tenant's saved config, or the env config when none is saved", async () => {
    await checks()['entra-id']({ clientId: 'app' }, 'tenant-a');
    await checks()['entra-id']({}, 'tenant-a');

    expect(deps.entra.checkEntraHealth).toHaveBeenNthCalledWith(1, { clientId: 'app' }, 'tenant-a');
    expect(deps.entra.checkEntraHealth).toHaveBeenNthCalledWith(2, undefined, 'tenant-a');
  });

  it('reads AD as healthy only when it connected', async () => {
    await expect(checks().ad({ host: 'dc1', port: '636' }, 'tenant-a')).resolves.toBe(false);
    expect(deps.ad.checkAdHealthEnriched).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'dc1', port: 636 }),
      'tenant-a',
    );
  });

  it('reports SCIM without a base URL as unhealthy without calling it', async () => {
    await expect(checks().scim({}, 'tenant-a')).resolves.toBe(false);
    expect(deps.scim.checkScimHealth).not.toHaveBeenCalled();
    await expect(checks().scim({ baseUrl: 'https://scim.example' }, 'tenant-a')).resolves.toBe(
      true,
    );
  });

  it('gives the HR sources their saved config; the other services load their own', async () => {
    await checks()['csv-hr']({ filePath: 'hr.csv' }, 'tenant-a');
    await checks().github({ orgName: 'ignored' }, 'tenant-a');

    expect(deps.csvHr.healthCheck).toHaveBeenCalledWith({ filePath: 'hr.csv' });
    expect(deps.gitHub.healthCheck).toHaveBeenCalledWith();
  });
});
