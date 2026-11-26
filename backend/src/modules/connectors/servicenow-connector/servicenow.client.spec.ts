/**
 * ServiceNowClient OAuth2 token cache: a token is reused only by a config with the same instance
 * URL, client id and secret. The instance URL and client id are not secret, so a config that
 * names another tenant's instance must not get that tenant's cached token.
 */
import axios from 'axios';
import { ServiceNowClient } from './servicenow.client';
import type { ServiceNowConfig } from './servicenow.interface';

jest.mock('axios', () => {
  const actual = jest.requireActual<typeof import('axios')>('axios');
  return {
    __esModule: true,
    default: { post: jest.fn(), create: jest.fn(), isAxiosError: actual.isAxiosError },
  };
});
const http = axios as unknown as { post: jest.Mock; create: jest.Mock };

const owner: ServiceNowConfig = {
  instanceUrl: 'https://acme.service-now.test',
  clientId: 'client-a',
  clientSecret: 'secret-a',
};

describe('ServiceNowClient token cache', () => {
  /** The Authorization header of each axios instance the client created. */
  const bearers = () =>
    http.create.mock.calls.map(
      ([options]) => (options as { headers: Record<string, string> }).headers.Authorization,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    http.post.mockImplementation(async (_url: string, body: string) => {
      const form = new URLSearchParams(body);
      return {
        data: {
          access_token: `${form.get('client_id')}/${form.get('client_secret')}`,
          expires_in: 1800,
        },
      };
    });
    http.create.mockImplementation(() => ({
      get: jest.fn().mockResolvedValue({ data: { result: [] } }),
    }));
  });

  it('reuses the token for the same config', async () => {
    const client = new ServiceNowClient();

    await client.getUser(owner, 'ada@acme.test');
    await client.getUser({ ...owner }, 'bob@acme.test');

    expect(http.post).toHaveBeenCalledTimes(1);
    expect(bearers()).toEqual(['Bearer client-a/secret-a', 'Bearer client-a/secret-a']);
  });

  it('fetches its own token for a config naming the same instance with other credentials', async () => {
    const client = new ServiceNowClient();

    await client.getUser(owner, 'ada@acme.test');
    await client.getUser({ ...owner, clientId: 'client-b', clientSecret: 'secret-b' }, 'x@b.test');
    await client.getUser({ ...owner, clientSecret: 'guessed' }, 'x@b.test');

    expect(http.post).toHaveBeenCalledTimes(3);
    expect(bearers()).toEqual([
      'Bearer client-a/secret-a',
      'Bearer client-b/secret-b',
      'Bearer client-a/guessed',
    ]);
  });
});

// Hunt 2026-11-25 (01 F11): getUser built `email=${email}` without escaping `^`, which separates
// encoded-query terms, and provision updates the record the lookup returns. An identity created
// through SCIM inbound keeps its email unvalidated, so `a^ORactive=true@x.fi` could select and
// overwrite another user's record. `^` is escaped as findUsersBy does it.
describe('ServiceNowClient.getUser', () => {
  it('keeps an email with ^ one encoded-query term', async () => {
    const get = jest.fn().mockResolvedValue({ data: { result: [] } });
    http.post.mockResolvedValue({ data: { access_token: 't', expires_in: 1800 } });
    http.create.mockImplementation(() => ({ get }));

    await new ServiceNowClient().getUser(owner, 'a^ORactive=true@acme.test');

    expect(get.mock.calls[0][1].params.sysparm_query).toBe('email=a^^ORactive=true@acme.test');
  });
});
