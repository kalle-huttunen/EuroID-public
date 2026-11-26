/**
 * Okta's runtime capability check (the health check answers it as `capabilities`): only
 * capabilities its manifest advertises and a code path serves. Okta has no credential operations
 * (no password reset, no credential state or MFA read), so credentialManagement is in neither.
 */
import { OktaDiscoveryService } from './okta-discovery.service';
import type { OktaClient } from './okta.client';
import type { OktaConfig } from './okta.interface';
import { oktaManifest } from './connector.manifest';

const config: OktaConfig = { orgUrl: 'https://acme.okta.example/', apiToken: 'ssws-test' };

describe('OktaDiscoveryService.validateCapabilities', () => {
  const client = { healthCheck: jest.fn(), listGroups: jest.fn() };
  const discovery = new OktaDiscoveryService(client as unknown as OktaClient);

  beforeEach(() => {
    client.healthCheck.mockReset().mockResolvedValue(true);
    client.listGroups.mockReset().mockResolvedValue([]);
  });

  it('answers what a reachable org supports, all of it in the manifest, no credentialManagement', async () => {
    const capabilities = await discovery.validateCapabilities(config);

    expect(capabilities).toEqual(['healthCheck', 'discover', 'provision', 'deprovision']);
    expect(oktaManifest.capabilities).toEqual(expect.arrayContaining(capabilities));
    expect(oktaManifest.capabilities).not.toContain('credentialManagement');
  });

  it('leaves out discover when the token cannot list groups', async () => {
    client.listGroups.mockRejectedValue(new Error('403'));

    await expect(discovery.validateCapabilities(config)).resolves.toEqual([
      'healthCheck',
      'provision',
      'deprovision',
    ]);
  });
});
