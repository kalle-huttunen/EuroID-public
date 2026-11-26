import * as http from 'http';
import { BadRequestException } from '@nestjs/common';
import type { AddressInfo } from 'net';
import { validateUrlForFetch } from '@infrastructure/url-validation/ssrf-guard';
import { JsonApiHrClient } from './json-api-hr.client';
import { JsonApiHrService } from './json-api-hr.service';

// The test server stands in for a public HR host; any other URL gets the real SSRF guard.
jest.mock('@infrastructure/url-validation/ssrf-guard', () => {
  const actual = jest.requireActual('@infrastructure/url-validation/ssrf-guard');
  return { ...actual, validateUrlForFetch: jest.fn(actual.validateUrlForFetch) };
});

const BODY_SECRET = 'body-text-that-must-not-leak';
const TOKEN = 'bearer-token-that-must-not-leak';

/**
 * POST /connectors/json-api-hr/health-check (JsonApiHrService.checkSource) against a real HTTP
 * server, with the connector's own client: one request as ingest makes it (the SSRF guard, the
 * configured auth, no redirect), and the body read the way ingest reads it, without mapping a
 * row. It answered 400 "Health check not implemented" before. The error names the HTTP status,
 * the network error or the parse failure, never a credential or the body.
 */
describe('JsonApiHrService.checkSource', () => {
  let server: http.Server;
  let base: string;
  let hits: string[];
  const service = new JsonApiHrService(new JsonApiHrClient());

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const json = (status: number, body: unknown) =>
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/users') return json(200, [{ email: 'a@example.com' }, { email: 'b' }]);
      if (req.url === '/wrapped') return json(200, { data: [{ email: 'a@example.com' }] });
      if (req.url === '/secured') {
        return req.headers.authorization === `Bearer ${TOKEN}`
          ? json(200, [])
          : json(401, { error: BODY_SECRET });
      }
      if (req.url === '/broken') return res.writeHead(503).end(BODY_SECRET);
      if (req.url === '/html') {
        return res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<p>${BODY_SECRET}</p>`);
      }
      return res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const actual = jest.requireActual('@infrastructure/url-validation/ssrf-guard');
    (validateUrlForFetch as jest.Mock).mockImplementation((url: string) =>
      url.startsWith(base) ? Promise.resolve() : actual.validateUrlForFetch(url),
    );
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    hits = [];
  });

  it('is healthy when the endpoint answers 2xx with the array ingest reads', async () => {
    await expect(service.checkSource({ url: `${base}/users` })).resolves.toEqual({
      healthy: true,
      message: 'The endpoint answered with 2 records',
    });
    await expect(
      service.checkSource({ url: `${base}/wrapped`, responsePath: 'data' }),
    ).resolves.toEqual({ healthy: true, message: 'The endpoint answered with 1 record' });
    expect(hits).toEqual(['GET /users', 'GET /wrapped']);
  });

  it('sends the configured credentials, as ingest does', async () => {
    await expect(
      service.checkSource({ url: `${base}/secured`, authType: 'bearer', bearerToken: TOKEN }),
    ).resolves.toMatchObject({ healthy: true });
  });

  it('names the HTTP status of a non-2xx answer, never the body or the credentials', async () => {
    const refused = await service.checkSource({
      url: `${base}/secured`,
      authType: 'bearer',
      bearerToken: 'wrong-token',
    });
    const broken = await service.checkSource({ url: `${base}/broken` });

    expect(refused).toEqual({ healthy: false, error: 'The endpoint answered HTTP 401' });
    expect(broken).toEqual({ healthy: false, error: 'The endpoint answered HTTP 503' });
    expect(JSON.stringify([refused, broken])).not.toMatch(/must-not-leak|wrong-token/);
  });

  it('says the body is not JSON without quoting it', async () => {
    const result = await service.checkSource({ url: `${base}/html` });

    expect(result).toEqual({ healthy: false, error: 'The response is not JSON' });
  });

  it('says where the array ingest expects is missing', async () => {
    await expect(service.checkSource({ url: `${base}/wrapped` })).resolves.toEqual({
      healthy: false,
      error:
        'JsonApiHrConnector: Response is not an array. Use responsePath (e.g. "data", "users") ' +
        'to specify the array location.',
    });
    await expect(
      service.checkSource({ url: `${base}/users`, responsePath: 'data' }),
    ).resolves.toMatchObject({ healthy: false, error: expect.stringContaining('did not resolve') });
  });

  it('names the network error of an endpoint that cannot be reached', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const url = `${base.replace(/:\d+$/, '')}:${(closed.address() as AddressInfo).port}/users`;
    await new Promise((resolve) => closed.close(resolve));
    (validateUrlForFetch as jest.Mock).mockResolvedValueOnce(undefined);

    await expect(service.checkSource({ url })).resolves.toEqual({
      healthy: false,
      error: 'The endpoint could not be reached (ECONNREFUSED)',
    });
  });

  it('checks the field map and the auth settings before any request', async () => {
    await expect(
      service.checkSource({ url: `${base}/users`, fieldMap: '{"email": ' }),
    ).resolves.toEqual({
      healthy: false,
      error: 'config.fieldMap: not valid JSON. Write an object such as {"Email": "email"}.',
    });
    await expect(
      service.checkSource({ url: `${base}/users`, authType: 'bearer' }),
    ).resolves.toEqual({
      healthy: false,
      error: 'JsonApiHrConnector: bearerToken is required for authType "bearer"',
    });
    await expect(service.checkSource({})).resolves.toEqual({
      healthy: false,
      error: 'url is required',
    });
    expect(hits).toEqual([]);
  });

  // The connector settings offer no method: a feed is read with GET. A check that could send
  // POST, PUT, PATCH or DELETE with the stored credentials would write to the HR system.
  it('reads the feed with GET only and refuses any other method with 400, without a request', async () => {
    for (const method of ['POST', 'PUT', 'patch', 'DELETE']) {
      await expect(service.checkSource({ url: `${base}/users`, method })).rejects.toThrow(
        BadRequestException,
      );
    }
    expect(hits).toEqual([]);

    await expect(service.checkSource({ url: `${base}/users`, method: 'get' })).resolves.toEqual({
      healthy: true,
      message: 'The endpoint answered with 2 records',
    });
    expect(hits).toEqual(['GET /users']);
  });

  it('refuses a private address the way ingest does, without a request', async () => {
    const url = 'https://10.0.0.5/users';
    await expect(service.fetchUsers({ url }, 'tenant-a')).rejects.toThrow(
      'URL targets a blocked IP range (private, loopback, link-local, metadata or reserved): 10.0.0.5',
    );

    await expect(service.checkSource({ url })).resolves.toEqual({
      healthy: false,
      error:
        'The URL is refused: URL targets a blocked IP range (private, loopback, link-local, ' +
        'metadata or reserved): 10.0.0.5',
    });
  });
});
