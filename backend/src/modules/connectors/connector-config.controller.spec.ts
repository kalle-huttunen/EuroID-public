/**
 * ConnectorConfigController when the connector's stored config cannot be decrypted by this
 * process: the routes answer that error (503, what to check) instead of a generic failure, and
 * leave no sync lock behind.
 */
import { Logger } from '@nestjs/common';
import { ConnectorConfigController } from './connector-config.controller';
import { ConnectorConfigDecryptError } from './connector-config.errors';
import type { InstallConnectorDto, UpdateConnectorDto } from './connector-config.dto';
import { ContractCriticalMasteryService } from '../identity/contract-critical-mastery.service';

type Ctor = ConstructorParameters<typeof ConnectorConfigController>;

function controllerWith(connectorName: string, capabilities: string[]) {
  const decryptError = new ConnectorConfigDecryptError(connectorName);
  const configService = {
    setSyncRunning: jest.fn().mockResolvedValue(true),
    isInstalled: jest.fn().mockResolvedValue(true),
    getConfig: jest.fn().mockRejectedValue(decryptError),
    updateSyncStatus: jest.fn().mockResolvedValue(undefined),
  };
  // HR ingestion reads the config itself (ConnectorConfigService.getConfig)
  const hrIngestion = { ingestFromConnector: jest.fn().mockRejectedValue(decryptError) };
  const pluginRegistry = { getById: jest.fn().mockReturnValue({ capabilities }) };
  const controller = new ConnectorConfigController(
    configService as unknown as Ctor[0],
    pluginRegistry as unknown as Ctor[1],
    hrIngestion as unknown as Ctor[2],
    {} as Ctor[3],
    {} as Ctor[4],
    {} as Ctor[5],
    {} as Ctor[6],
    {} as Ctor[7],
    {} as Ctor[8],
    {} as Ctor[9],
  );
  return { controller, configService, decryptError };
}

describe('ConnectorConfigController with a config this process cannot decrypt', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POST /connectors/:name/ingest answers the decrypt error and records the failed run', async () => {
    const { controller, configService, decryptError } = controllerWith('csv-hr', ['ingest']);

    await expect(controller.ingest('csv-hr')).rejects.toBe(decryptError);
    // The failed status replaces 'running', so the next sync is not blocked
    expect(configService.updateSyncStatus).toHaveBeenCalledWith(
      'csv-hr',
      expect.objectContaining({ lastSyncStatus: 'failed' }),
    );
  });

  it('POST /connectors/:name/discover answers the decrypt error without taking the sync lock', async () => {
    const { controller, configService, decryptError } = controllerWith('entra-id', ['discover']);

    await expect(controller.discover('entra-id')).rejects.toBe(decryptError);
    expect(configService.setSyncRunning).not.toHaveBeenCalled();
    expect(configService.updateSyncStatus).not.toHaveBeenCalled();
  });
});

/**
 * Contract-critical fields always come from the primary HR contract (owner decision 2026-11-24):
 * installing or updating an HR connector whose mastery fields list one is refused (400, nothing
 * saved) unless the Contract Tag and ingest priority make that connector the primary, as the
 * Recon Config and Design studio saves refuse it. The connector used to store it, and its
 * identities then took the field from it as their explicit master.
 */
describe('ConnectorConfigController: mastery of a contract-critical field', () => {
  const reconConfig = { getConfig: jest.fn() };
  const correlation = {
    getHrConnectorsWithPriorityFromBlueprint: jest.fn(),
    getInstalledHrConnectorsWithPriority: jest.fn(),
  };
  const configService = {
    install: jest.fn(async (name: string) => ({ connectorName: name, installedAt: new Date() })),
    updateConfig: jest.fn(async (name: string) => ({ connectorName: name, updatedAt: new Date() })),
    getConfig: jest.fn(async () => ({ config: {} })),
  };
  const controller = new ConnectorConfigController(
    configService as unknown as Ctor[0],
    {} as Ctor[1],
    {} as Ctor[2],
    {} as Ctor[3],
    {} as Ctor[4],
    {} as Ctor[5],
    new ContractCriticalMasteryService(reconConfig as never, correlation as never),
    {} as Ctor[7],
    {} as Ctor[8],
    {} as Ctor[9],
  );
  const install = (name: string, body: Omit<InstallConnectorDto, 'config'>) =>
    controller.install(name, { config: {}, ...body } as InstallConnectorDto);

  beforeEach(() => {
    jest.clearAllMocks();
    reconConfig.getConfig.mockResolvedValue({
      hrSourceTags: ['csv-hr', 'json-api-hr'],
      sourcePriorityOrder: ['csv-hr', 'json-api-hr'],
      contractCriticalFields: ['departmentName'],
      defaultMastery: {},
      targetIdKeys: [],
    });
    correlation.getHrConnectorsWithPriorityFromBlueprint.mockResolvedValue([]);
    correlation.getInstalledHrConnectorsWithPriority.mockResolvedValue([
      { name: 'csv-hr', ingestPriority: 1, contractTag: 'PRIMARY' },
    ]);
  });

  it('refuses installing a secondary HR connector that masters one, and installs nothing', async () => {
    await expect(
      install('json-api-hr', {
        contractTag: 'SECONDARY',
        ingestPriority: 2,
        masteryFields: ['departmentName', 'location'],
      }),
    ).rejects.toThrow(
      'Field Mastery of source json-api-hr: departmentName names json-api-hr. Contract-critical ' +
        'fields always come from the primary HR contract (now csv-hr)',
    );
    expect(configService.install).not.toHaveBeenCalled();
  });

  it('refuses a PATCH that tags the primary Secondary while it masters one', async () => {
    correlation.getInstalledHrConnectorsWithPriority.mockResolvedValue([
      { name: 'csv-hr', ingestPriority: 1, contractTag: 'PRIMARY', masteryFields: [] },
      { name: 'json-api-hr', ingestPriority: 2, contractTag: 'PRIMARY' },
    ]);

    await expect(
      controller.updateConfig('csv-hr', {
        contractTag: 'SECONDARY',
        masteryFields: ['departmentName'],
      } as UpdateConnectorDto),
    ).rejects.toThrow('departmentName names csv-hr');
    expect(configService.updateConfig).not.toHaveBeenCalled();
  });

  it('saves the primary HR connector mastering it, and other fields on any connector', async () => {
    await install('csv-hr', { contractTag: 'PRIMARY', masteryFields: ['departmentName'] });
    await install('json-api-hr', { contractTag: 'SECONDARY', masteryFields: ['location'] });

    expect(configService.install).toHaveBeenCalledTimes(2);
  });

  it('takes the primary from the Design studio source nodes when the canvas has them', async () => {
    correlation.getHrConnectorsWithPriorityFromBlueprint.mockResolvedValue([
      { name: 'json-api-hr', ingestPriority: 1, contractTag: 'PRIMARY' },
      { name: 'csv-hr', ingestPriority: 2, contractTag: 'SECONDARY' },
    ]);

    await install('json-api-hr', { masteryFields: ['departmentName'] });

    expect(configService.install).toHaveBeenCalledTimes(1);
    expect(correlation.getInstalledHrConnectorsWithPriority).not.toHaveBeenCalled();
  });
});

/**
 * POST /connectors/:name/health-check answered 400 "Health check not implemented" for every
 * connector but Entra ID, AD and SCIM, although csv-hr, json-api-hr, okta, servicenow, github,
 * google-sheets, discord-webhook and file-outbound declare `healthCheck`. The HR sources run their
 * detailed check (checkSource) with the config the route was given; the others run their own
 * health check (the one GET /reconciliation/connector-health runs), which reads the saved config.
 */
describe('ConnectorConfigController: POST /connectors/:name/health-check', () => {
  const saved = { filePath: 'employees.csv', bearerToken: 'stored-token' };
  const configService = {
    getConfig: jest.fn(async () => ({ config: saved })),
    withStoredSecrets: jest.fn(async (_name: string, config: Record<string, string>) => config),
  };
  const manifests: Record<string, { capabilities: string[] }> = {
    'csv-hr': { capabilities: ['ingest', 'healthCheck'] },
    'json-api-hr': { capabilities: ['ingest', 'healthCheck'] },
    okta: { capabilities: ['provision', 'healthCheck'] },
    'some-new-connector': { capabilities: ['provision', 'healthCheck'] },
  };
  const pluginRegistry = {
    getById: jest.fn((name: string) => manifests[name]),
    getValidatedCapabilities: jest.fn(async (name: string) => manifests[name].capabilities),
  };
  const csvHr = { checkSource: jest.fn() };
  const jsonApiHr = { checkSource: jest.fn() };
  const okta = jest.fn();
  const controller = new ConnectorConfigController(
    configService as unknown as Ctor[0],
    pluginRegistry as unknown as Ctor[1],
    {} as Ctor[2],
    {} as Ctor[3],
    {} as Ctor[4],
    {} as Ctor[5],
    {} as Ctor[6],
    csvHr as unknown as Ctor[7],
    jsonApiHr as unknown as Ctor[8],
    { okta } as unknown as Ctor[9],
  );
  const user = { tenantId: 'tenant-a' } as Parameters<typeof controller.healthCheck>[2];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('checks the saved CSV HR source and answers what the check found', async () => {
    csvHr.checkSource.mockResolvedValue({
      healthy: true,
      message: 'employees.csv can be read (34 bytes) and the column map is valid',
    });

    await expect(controller.healthCheck('csv-hr', {}, user)).resolves.toEqual({
      healthy: true,
      connected: true,
      message: 'employees.csv can be read (34 bytes) and the column map is valid',
      capabilities: ['ingest', 'healthCheck'],
    });
    expect(csvHr.checkSource).toHaveBeenCalledWith(saved);
  });

  it('checks the JSON API HR config the form sent, its masked secrets restored', async () => {
    const sent = { url: 'https://hr.example.com/users', bearerToken: '********' };
    configService.withStoredSecrets.mockResolvedValueOnce({ ...sent, bearerToken: 'stored' });
    jsonApiHr.checkSource.mockResolvedValue({
      healthy: false,
      error: 'The endpoint answered HTTP 401',
    });

    await expect(controller.healthCheck('json-api-hr', { config: sent }, user)).resolves.toEqual({
      healthy: false,
      connected: false,
      error: 'The endpoint answered HTTP 401',
      capabilities: ['ingest', 'healthCheck'],
    });
    expect(jsonApiHr.checkSource).toHaveBeenCalledWith({ ...sent, bearerToken: 'stored' });
  });

  it("runs another connector's own health check, which reads the saved config", async () => {
    okta.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(controller.healthCheck('okta', {}, user)).resolves.toEqual({
      healthy: true,
      connected: true,
      capabilities: ['provision', 'healthCheck'],
    });
    await expect(
      controller.healthCheck('okta', { config: { orgUrl: 'https://x.okta.com' } }, user),
    ).resolves.toEqual({
      healthy: false,
      connected: false,
      error: 'Health check failed',
      message: 'Checked with the saved config: this connector does not test unsaved settings',
      capabilities: ['provision', 'healthCheck'],
    });
    // The form's values never reach a check that tests the saved config
    expect(okta).toHaveBeenNthCalledWith(1, saved, 'tenant-a');
    expect(okta).toHaveBeenNthCalledWith(2, saved, 'tenant-a');
  });

  it('keeps the 400 for a connector that declares healthCheck and has no check', async () => {
    await expect(controller.healthCheck('some-new-connector', {}, user)).rejects.toThrow(
      'Health check not implemented for connector "some-new-connector"',
    );
  });
});

/**
 * Hunt 2026-11-25 (01 F13): the install body's `installedBy` became the audit actor of
 * CONNECTOR_INSTALLED, so a connector-admin could name anyone as the installer, and uninstall
 * and config updates were audited as 'admin'. Every one is now the signed-in user.
 */
describe('ConnectorConfigController: who installed, removed or changed a connector', () => {
  const configService = {
    install: jest.fn(async (name: string) => ({ connectorName: name, installedAt: new Date() })),
    uninstall: jest.fn(async () => undefined),
    updateConfig: jest.fn(async (name: string) => ({ connectorName: name, updatedAt: new Date() })),
    getConfig: jest.fn(async () => ({ config: {} })),
  };
  const controller = new ConnectorConfigController(
    configService as unknown as Ctor[0],
    {} as Ctor[1],
    {} as Ctor[2],
    {} as Ctor[3],
    {} as Ctor[4],
    {} as Ctor[5],
    {} as Ctor[6],
    {} as Ctor[7],
    {} as Ctor[8],
    {} as Ctor[9],
  );
  const user = { sub: 'u-1', email: 'ada@acme.test', name: 'Ada', roles: [], tenantId: 't-1' };

  beforeEach(() => jest.clearAllMocks());

  it('records the signed-in user as the installer, whatever the body says', async () => {
    await controller.install(
      'okta',
      { config: {}, installedBy: 'someone-else@acme.test' } as unknown as InstallConnectorDto,
      user,
    );

    expect(configService.install).toHaveBeenCalledWith('okta', {}, 'ada@acme.test', undefined);
  });

  it('passes the signed-in user as the actor of an uninstall and a config update', async () => {
    await controller.uninstall('okta', user);
    await controller.updateConfig('okta', { config: { orgUrl: 'https://x' } }, user);

    expect(configService.uninstall).toHaveBeenCalledWith('okta', 't-1', 'ada@acme.test');
    expect(configService.updateConfig).toHaveBeenCalledWith(
      'okta',
      { orgUrl: 'https://x' },
      undefined,
      'ada@acme.test',
    );
  });
});
