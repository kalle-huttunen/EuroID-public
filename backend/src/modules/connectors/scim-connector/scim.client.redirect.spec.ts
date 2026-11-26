import * as http from 'http';
import type { AddressInfo } from 'net';
import { BadRequestException } from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { validateUrlForFetch } from '@infrastructure/url-validation/ssrf-guard';
import type { ConnectorCircuitBreakerService } from '@infrastructure/resilience/connector-circuit-breaker';
import { SCIMClient } from './scim.client';
import type { SCIMConnectorConfig } from './scim.interface';

// Only the configured SCIM server passes validation (it stands in for a public host); any other
// URL gets the real SSRF guard.
jest.mock('@infrastructure/url-validation/ssrf-guard', () => {
  const actual = jest.requireActual('@infrastructure/url-validation/ssrf-guard');
  return { ...actual, validateUrlForFetch: jest.fn(actual.validateUrlForFetch) };
});

function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * SSRF: validateUrlForFetch checks only the configured base URL and token URL, so a redirect
 * from either would send the connector to a private or cloud-metadata address, a 307 or 308
 * with the token request's client secret in its body (hunt 2026-11-25, 01 F7). Real HTTP with
 * real axios, no mocks of the transport.
 */
describe('SCIMClient redirects', () => {
  let metadata: { server: http.Server; base: string };
  let scim: { server: http.Server; base: string };
  let metadataHits: string[] = [];

  beforeAll(async () => {
    metadata = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        metadataHits.push(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: 'stolen', Resources: [] }));
      });
    });
    scim = await listen((req, res) => {
      res.statusCode = req.url?.startsWith('/token') ? 307 : 302;
      res.setHeader('Location', `${metadata.base}/latest/meta-data${req.url}`);
      res.end();
    });
    const actual = jest.requireActual('@infrastructure/url-validation/ssrf-guard');
    (validateUrlForFetch as jest.Mock).mockImplementation((url: string) =>
      url.startsWith(scim.base) ? Promise.resolve() : actual.validateUrlForFetch(url),
    );
  });

  afterAll(async () => {
    await new Promise((resolve) => scim.server.close(resolve));
    await new Promise((resolve) => metadata.server.close(resolve));
  });

  beforeEach(() => {
    metadataHits = [];
  });

  const client = () =>
    new SCIMClient(
      { get: jest.fn().mockResolvedValue(undefined), set: jest.fn() } as unknown as Cache,
      {
        execute: (_c: string, fn: () => Promise<unknown>) => fn(),
      } as unknown as ConnectorCircuitBreakerService,
    );

  it('refuses a redirect of a SCIM request and never follows it', async () => {
    const config: SCIMConnectorConfig = {
      baseUrl: `${scim.base}/scim/v2`,
      authType: 'bearer',
      bearerToken: 'stored-token',
    };

    await expect(client().listUsers(config)).rejects.toThrow(BadRequestException);
    expect(metadataHits).toHaveLength(0);
  });

  it('never sends the client secret on after a 307 from the token URL', async () => {
    const config: SCIMConnectorConfig = {
      baseUrl: `${scim.base}/scim/v2`,
      authType: 'oauth2',
      oauth2TokenUrl: `${scim.base}/token`,
      clientId: 'client',
      clientSecret: 'stored-secret',
    };

    await expect(client().listUsers(config)).rejects.toThrow(BadRequestException);
    expect(metadataHits).toHaveLength(0);
  });
});
