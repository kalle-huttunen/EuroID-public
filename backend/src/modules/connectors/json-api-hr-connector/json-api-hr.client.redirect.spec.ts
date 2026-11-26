import * as http from 'http';
import type { AddressInfo } from 'net';
import { BadRequestException } from '@nestjs/common';
import { validateUrlForFetch } from '@infrastructure/url-validation/ssrf-guard';
import { JsonApiHrClient } from './json-api-hr.client';

// Only the configured HR URL passes validation (it stands in for a public host); any other
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
 * SSRF: validateUrlForFetch only checks the configured URL, so following a redirect would let
 * an HR endpoint send the connector to a private or cloud-metadata address. Real HTTP with
 * real axios, no mocks of the transport.
 */
describe('JsonApiHrClient redirects', () => {
  let metadata: { server: http.Server; base: string };
  let hr: { server: http.Server; base: string };
  let metadataHits = 0;

  beforeAll(async () => {
    metadata = await listen((_req, res) => {
      metadataHits++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ email: 'leaked@metadata.internal' }]));
    });
    hr = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `${metadata.base}/latest/meta-data/iam/`);
      res.end();
    });
    const actual = jest.requireActual('@infrastructure/url-validation/ssrf-guard');
    (validateUrlForFetch as jest.Mock).mockImplementation((url: string) =>
      url.startsWith(hr.base) ? Promise.resolve() : actual.validateUrlForFetch(url),
    );
  });

  afterAll(async () => {
    await new Promise((resolve) => hr.server.close(resolve));
    await new Promise((resolve) => metadata.server.close(resolve));
  });

  beforeEach(() => {
    metadataHits = 0;
  });

  it.each([
    ['without auth', undefined],
    ['with a bearer token', { type: 'bearer' as const, token: 't-123' }],
  ])('refuses a redirect to a private address %s', async (_label, auth) => {
    const client = new JsonApiHrClient();

    await expect(client.fetch({ url: `${hr.base}/users`, auth })).rejects.toThrow(
      BadRequestException,
    );
    expect(metadataHits).toBe(0);
  });
});
