/**
 * GET /blueprints/connector-status/:id answered a rate limit of 5000 of 10000 and a credential
 * expiry of CREDENTIAL_EXPIRY_DAYS (default "45 days") for every connector: values EuroID never
 * read from the target, shown in the Design studio's connector manager as facts (hunt 05 F18).
 * The answer holds what was checked: the health and whether the credentials worked.
 */
import { BlueprintsController } from './blueprints.controller';

describe('GET /blueprints/connector-status/:id', () => {
  const controller = (healthy: boolean) =>
    new BlueprintsController(
      { getNodeConfig: jest.fn().mockResolvedValue({ config: { tenantId: 't' } }) } as never,
      {} as never,
      {} as never,
      {} as never,
      { checkConnection: jest.fn().mockResolvedValue(healthy) } as never,
      { DEFAULT_TENANT_ID: 'default' } as never,
    );

  it.each([true, false])('reports only what it checked (healthy: %s)', async (healthy) => {
    const status = await controller(healthy).getConnectorStatus('entra-id-target-1');

    expect(status).toEqual({
      name: 'entra-id-target-1',
      type: 'Microsoft Entra ID',
      health: healthy ? 'online' : 'offline',
      enabled: true,
      credentials: { valid: healthy },
      ...(healthy ? {} : { errorMessage: 'Unable to connect to target system' }),
    });
  });
});
