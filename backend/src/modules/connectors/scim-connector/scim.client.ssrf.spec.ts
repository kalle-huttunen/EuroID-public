/**
 * SSRF: the SCIM client fetches the tenant's base URL and OAuth token URL. The real guard refuses
 * a blocked URL before any request: the error reaches the caller and axios is never called (the
 * other SCIM client specs mock the guard). DNS is stubbed, and axios is mocked so that nothing
 * could leave the process even if the guard let a URL through.
 */
import axios from 'axios';
import { stubOutboundConnections, v4 } from '@testing/stub-outbound-connect';
import { SCIMClient } from './scim.client';
import type { SCIMConnectorConfig } from './scim.interface';
import { SCIM_SCHEMAS } from '@shared/scim';

jest.mock('axios');

const mockedAxios = axios as jest.MockedFunction<typeof axios>;
const mockedPost = axios.post as jest.MockedFunction<typeof axios.post>;

const bearer = (baseUrl: string): SCIMConnectorConfig => ({
  baseUrl,
  authType: 'bearer',
  bearerToken: 'scim-token',
});
const user = { schemas: [SCIM_SCHEMAS.USER], userName: 'ada@acme.test' };

describe('SCIMClient: the SSRF guard on tenant URLs', () => {
  let answerDns: ReturnType<typeof stubOutboundConnections>['answerDns'];
  let client: SCIMClient;

  beforeEach(() => {
    ({ answerDns } = stubOutboundConnections());
    mockedAxios.mockReset();
    mockedPost.mockReset();
    client = new SCIMClient(
      { get: jest.fn(), set: jest.fn(), del: jest.fn() } as never,
      { execute: jest.fn((_name: string, fn: () => Promise<unknown>) => fn()) } as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    'https://169.254.169.254/scim/v2',
    'http://127.0.0.1/scim/v2',
    'https://localhost/scim/v2',
  ])('refuses the base URL %s before any request', async (baseUrl) => {
    await expect(client.createUser(bearer(baseUrl), user)).rejects.toThrow(/blocked|Only HTTPS/);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('refuses a base URL whose host resolves to a private address', async () => {
    answerDns([v4('10.0.0.5')]);

    await expect(client.createUser(bearer('https://scim.acme.test/v2'), user)).rejects.toThrow(
      'URL resolves to blocked IP 10.0.0.5 (scim.acme.test)',
    );
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('refuses the OAuth token URL before asking it for a token', async () => {
    const config: SCIMConnectorConfig = {
      baseUrl: 'https://93.184.215.14/scim/v2',
      authType: 'oauth2',
      oauth2TokenUrl: 'https://169.254.169.254/oauth/token',
      clientId: 'client',
      clientSecret: 'secret',
    };

    await expect(client.createUser(config, user)).rejects.toThrow(/blocked IP range/);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('is unhealthy for a refused base URL, without a request', async () => {
    await expect(client.healthCheck(bearer('https://169.254.169.254/scim/v2'))).resolves.toBe(
      false,
    );
    expect(mockedAxios).not.toHaveBeenCalled();
  });
});
