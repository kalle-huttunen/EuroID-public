/**
 * Okta provisioning against a mocked OktaClient (the HTTP layer), real mapper. Untested against a
 * live Okta org.
 */
import { createMockUser } from '@testing';
import { OktaProvisioningService } from './okta-provisioning.service';
import { OktaMapper } from './okta.mapper';
import type { OktaClient } from './okta.client';
import type { OktaConfig } from './okta.interface';

const config: OktaConfig = {
  orgUrl: 'https://acme.okta.example',
  apiToken: 'ssws-test',
  defaultGroupId: 'grp-default',
};

function oktaError(status: number, data: Record<string, unknown> = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });
}

/** Okta's answer to a create whose login another user has (400 E0000001, from Okta's docs). */
const duplicateLogin = () =>
  oktaError(400, {
    errorCode: 'E0000001',
    errorSummary: 'Api validation failed: login',
    errorCauses: [
      {
        errorSummary: 'login: An object with this field already exists in the current organization',
      },
    ],
  });

function setup() {
  const client = {
    createUser: jest.fn().mockResolvedValue({ id: '00u-new', status: 'PROVISIONED' }),
    getUser: jest.fn().mockResolvedValue({ id: '00u-existing', status: 'ACTIVE' }),
    updateUser: jest.fn().mockResolvedValue({ id: '00u-existing' }),
    addUserToGroup: jest.fn().mockResolvedValue(undefined),
  };
  const service = new OktaProvisioningService(client as unknown as OktaClient, new OktaMapper());
  return { client, service };
}

describe('OktaProvisioningService.provision', () => {
  // Hunt 2026-11-25 (01 F6): only a 409 was taken for "already exists", but Okta answers a
  // duplicate login with 400 E0000001, so a retried provision threw on its own user forever
  it('updates the existing user when Okta refuses the create as a duplicate login', async () => {
    const { client, service } = setup();
    client.createUser.mockRejectedValue(duplicateLogin());
    const user = createMockUser({ email: 'ada@acme.example' });

    await expect(service.provision(config, user)).resolves.toEqual({
      targetUserId: '00u-existing',
    });
    expect(client.getUser).toHaveBeenCalledWith(config, 'ada@acme.example');
    expect(client.updateUser).toHaveBeenCalledWith(config, '00u-existing', expect.any(Object));
  });

  it('still fails on another validation error', async () => {
    const { client, service } = setup();
    client.createUser.mockRejectedValue(
      oktaError(400, {
        errorCode: 'E0000001',
        errorCauses: [{ errorSummary: 'email: Does not match required pattern' }],
      }),
    );

    await expect(service.provision(config, createMockUser())).rejects.toThrow(/400/);
    expect(client.updateUser).not.toHaveBeenCalled();
  });

  // Hunt 2026-11-25 (r2-01 N8): the default group was added only to a user this run created, so a
  // retry after a first attempt that created the user and then failed left it out of the group
  it('adds an existing user to the default group too (the add is idempotent)', async () => {
    const { client, service } = setup();
    client.createUser.mockRejectedValue(oktaError(409));

    await service.provision(config, createMockUser());

    expect(client.addUserToGroup).toHaveBeenCalledWith(config, 'grp-default', '00u-existing');
  });

  // From package G's report (okta.client.ts:78): a linked admin account was created activated,
  // so it became ACTIVE outside any session once its owner finished activation
  it('creates a linked admin account STAGED and a regular joiner activated', async () => {
    const { client, service } = setup();

    await service.provision(
      config,
      createMockUser({ employmentType: 'ADMIN_ACCOUNT' as never, sourceSystem: 'euroid-pam' }),
    );
    await service.provision(config, createMockUser());

    expect(client.createUser.mock.calls.map((call) => call[2])).toEqual([false, true]);
  });
});
