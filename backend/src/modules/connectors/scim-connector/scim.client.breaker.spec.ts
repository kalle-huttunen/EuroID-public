/**
 * SCIM calls and the circuit breaker (connector-circuit-breaker.ts): a call had no timeout, so a
 * SCIM server that never answered held the activity until its own timeout, and every status was
 * an answer to axios (validateStatus), so a server answering 5xx never counted as failing and was
 * never cut off. 5xx answers and timeouts now reach isTargetFailure; 4xx answers do not.
 */
import axios from 'axios';
import { BrokenCircuitError } from 'cockatiel';
import { SCIMError, SCIM_SCHEMAS } from '@shared/scim';
import { CONNECTOR_TIMEOUT_MS } from '@infrastructure/config/defaults';
import { ConnectorCircuitBreakerService } from '@infrastructure/resilience/connector-circuit-breaker';
import { SCIMClient } from './scim.client';
import type { SCIMConnectorConfig } from './scim.interface';

jest.mock('axios');
jest.mock('@infrastructure/url-validation/ssrf-guard', () => ({
  ...jest.requireActual('@infrastructure/url-validation/ssrf-guard'),
  validateUrlForFetch: jest.fn().mockResolvedValue(undefined),
}));
const mockedAxios = axios as jest.MockedFunction<typeof axios>;
const mockedPost = axios.post as jest.MockedFunction<typeof axios.post>;

const config: SCIMConnectorConfig = {
  baseUrl: 'https://scim.example.com/v2',
  authType: 'bearer',
  bearerToken: 'token',
};

const answer = (status: number) => ({
  status,
  data: { schemas: [SCIM_SCHEMAS.ERROR], detail: `HTTP ${status}`, status: String(status) },
});

describe('SCIMClient and the circuit breaker', () => {
  let client: SCIMClient;

  beforeEach(() => {
    jest.clearAllMocks();
    const breaker = new ConnectorCircuitBreakerService(
      { emit: jest.fn() } as never,
      {
        circuitBreakerTripsTotal: { inc: jest.fn() },
        circuitBreakerState: { set: jest.fn() },
      } as never,
    );
    const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
    client = new SCIMClient(cache as never, breaker);
  });

  it('gives every SCIM call and the OAuth token request the connector timeout', async () => {
    mockedAxios.mockResolvedValue({ status: 200, data: { id: 'u1' } });
    mockedPost.mockResolvedValue({ data: { access_token: 'at', expires_in: 3600 } });

    await client.getUser(config, 'u1');
    await client.getUser(
      {
        baseUrl: config.baseUrl,
        authType: 'oauth2',
        oauth2TokenUrl: 'https://auth.example.com/token',
        clientId: 'id',
        clientSecret: 'secret',
      },
      'u1',
    );

    expect(mockedAxios.mock.calls[0][0]).toMatchObject({ timeout: CONNECTOR_TIMEOUT_MS });
    expect(mockedPost.mock.calls[0][2]).toMatchObject({ timeout: CONNECTOR_TIMEOUT_MS });
  });

  it('opens the breaker after five 5xx answers, still answering each with its SCIM error', async () => {
    mockedAxios.mockResolvedValue(answer(503));

    for (let i = 0; i < 5; i++) {
      const err = await client.getUser(config, 'u1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SCIMError);
      expect((err as SCIMError).scimStatus).toBe('503');
    }
    mockedAxios.mockClear();

    await expect(client.getUser(config, 'u1')).rejects.toBeInstanceOf(BrokenCircuitError);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('opens the breaker after five timeouts', async () => {
    mockedAxios.mockRejectedValue(
      Object.assign(new Error(`timeout of ${CONNECTOR_TIMEOUT_MS}ms exceeded`), {
        code: 'ECONNABORTED',
      }),
    );

    for (let i = 0; i < 5; i++) await client.getUser(config, 'u1').catch(() => undefined);

    await expect(client.getUser(config, 'u1')).rejects.toBeInstanceOf(BrokenCircuitError);
  });

  it('never counts a 4xx answer: the server is answering', async () => {
    mockedAxios.mockResolvedValue(answer(404));

    for (let i = 0; i < 6; i++) {
      await expect(client.getUser(config, 'u1')).rejects.toBeInstanceOf(SCIMError);
    }
    expect(mockedAxios).toHaveBeenCalledTimes(6);
  });
});
