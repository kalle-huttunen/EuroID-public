/**
 * Okta group membership for access reviews and the mover through the real service and client
 * against a mocked Okta API (axios mocked): the user's groups on every page (Link rel="next",
 * only to this org), a missing user, and the add and removal calls. Untested against a live
 * Okta org.
 */
import axios from 'axios';
import { OktaClient } from './okta.client';
import { OktaMapper } from './okta.mapper';
import { OktaProvisioningService } from './okta-provisioning.service';
import type { OktaConfig } from './okta.interface';
import { httpError } from '@testing/fake-http';

jest.mock('axios');

const config: OktaConfig = { orgUrl: 'https://acme.okta.example/', apiToken: 'ssws-test' };
const API = 'https://acme.okta.example/api/v1';

/** axios instance whose GET answers come from `pages` (by path), with optional Link headers. */
function oktaApi(
  pages: Record<string, { data: unknown; link?: string } | Error>,
  putError?: Error,
) {
  const calls: Array<{ method: string; url: string }> = [];
  const instance = {
    get: jest.fn(async (url: string) => {
      calls.push({ method: 'GET', url });
      const page = pages[url];
      if (!page) throw httpError(404);
      if (page instanceof Error) throw page;
      return { status: 200, data: page.data, headers: page.link ? { link: page.link } : {} };
    }),
    delete: jest.fn(async (url: string) => {
      calls.push({ method: 'DELETE', url });
      return { status: 204, data: undefined, headers: {} };
    }),
    put: jest.fn(async (url: string) => {
      calls.push({ method: 'PUT', url });
      if (putError) throw putError;
      return { status: 204, data: undefined, headers: {} };
    }),
  };
  (axios.create as jest.Mock).mockReturnValue(instance);
  return { calls, service: new OktaProvisioningService(new OktaClient(), new OktaMapper()) };
}

const group = (id: string, type = 'OKTA_GROUP') => ({ id, type, profile: { name: id } });

describe('OktaProvisioningService group membership', () => {
  it("lists the user's groups across pages", async () => {
    const { service, calls } = oktaApi({
      '/users/00u1/groups': {
        data: [group('00g1')],
        link: `<${API}/users/00u1/groups?limit=1>; rel="self", <${API}/users/00u1/groups?after=00g1&limit=1>; rel="next"`,
      },
      '/users/00u1/groups?after=00g1&limit=1': { data: [group('00g2', 'APP_GROUP')] },
    });

    await expect(service.listUserGroups(config, '00u1')).resolves.toEqual([
      group('00g1'),
      group('00g2', 'APP_GROUP'),
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      '/users/00u1/groups',
      '/users/00u1/groups?after=00g1&limit=1',
    ]);
  });

  it('does not follow a next link to another host', async () => {
    const { service, calls } = oktaApi({
      '/users/00u1/groups': {
        data: [group('00g1')],
        link: '<https://evil.example/api/v1/users/00u1/groups?after=x>; rel="next"',
      },
    });
    await expect(service.listUserGroups(config, '00u1')).resolves.toEqual([group('00g1')]);
    expect(calls).toHaveLength(1);
  });

  it('is null for a user Okta does not know, and finds a user id by login', async () => {
    const { service } = oktaApi({
      '/users/ada%40acme.test': { data: { id: '00u7', status: 'ACTIVE', profile: {} } },
    });
    await expect(service.listUserGroups(config, '00u1')).resolves.toBeNull();
    await expect(service.findUserIdByLogin(config, 'ada@acme.test')).resolves.toBe('00u7');
    await expect(service.findUserIdByLogin(config, 'bob@acme.test')).resolves.toBeNull();
  });

  it('propagates errors other than 404 (bad token)', async () => {
    const { service } = oktaApi({ '/users/00u1/groups': httpError(401) });
    await expect(service.listUserGroups(config, '00u1')).rejects.toMatchObject({
      response: { status: 401 },
    });
  });

  it('removes the user from the group', async () => {
    const { service, calls } = oktaApi({});
    await service.removeGroupMember(config, '00g1', '00u1');
    expect(calls).toEqual([{ method: 'DELETE', url: '/groups/00g1/users/00u1' }]);
  });

  it('adds the user to the group (mover)', async () => {
    const { service, calls } = oktaApi({});
    await service.addGroupMember(config, '00g1', '00u1');
    expect(calls).toEqual([{ method: 'PUT', url: '/groups/00g1/users/00u1' }]);
  });

  it('propagates a refused add (an APP_GROUP Okta does not let the API change)', async () => {
    const { service } = oktaApi({}, httpError(403));
    await expect(service.addGroupMember(config, '00g-app', '00u1')).rejects.toMatchObject({
      response: { status: 403 },
    });
  });
});
