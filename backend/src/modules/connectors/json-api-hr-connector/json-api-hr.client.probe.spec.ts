import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { validateUrlForFetch } from '@infrastructure/url-validation/ssrf-guard';
import { JsonApiHrClient } from './json-api-hr.client';

// The test server stands in for a public HR host; any other URL gets the real SSRF guard.
jest.mock('@infrastructure/url-validation/ssrf-guard', () => {
  const actual = jest.requireActual('@infrastructure/url-validation/ssrf-guard');
  return { ...actual, validateUrlForFetch: jest.fn(actual.validateUrlForFetch) };
});

/** Chunks of the HR feed a GET would stream: far more than a health check may read. */
const FEED_CHUNKS = 200;
const CHUNK = JSON.stringify({ email: 'someone@example.com', padding: 'x'.repeat(1000) });

interface Hit {
  method: string;
  path: string;
  /** Whether the server got to send the whole feed (false when the client hung up first). */
  feedCompleted?: boolean;
}

/**
 * The health check of the JSON API HR connector against a real HTTP server, with real axios: it
 * must not download the HR feed (one HEAD, or a GET whose body it drops), and it is healthy only
 * when the endpoint accepts the credentials.
 */
describe('JsonApiHrClient.probe', () => {
  let server: http.Server;
  let base: string;
  let hits: Hit[];
  const client = new JsonApiHrClient();

  /** Streams the feed slowly, so a client that reads it all would take seconds. */
  const streamFeed = (res: http.ServerResponse, hit: Hit) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders();
    let sent = 0;
    const timer = setInterval(() => {
      if (sent === FEED_CHUNKS) {
        clearInterval(timer);
        res.end(']');
        hit.feedCompleted = true;
        return;
      }
      res.write(sent === 0 ? `[${CHUNK}` : `,${CHUNK}`);
      sent++;
    }, 10);
    res.on('close', () => {
      clearInterval(timer);
      hit.feedCompleted ??= false;
    });
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const hit: Hit = { method: req.method ?? '', path: req.url ?? '' };
      hits.push(hit);
      const authorized = req.headers.authorization === 'Bearer good-token';
      if (req.url === '/feed') {
        if (req.method === 'HEAD') return res.writeHead(200).end();
        return streamFeed(res, hit);
      }
      if (req.url === '/feed-without-head') {
        if (req.method === 'HEAD') return res.writeHead(405).end();
        return streamFeed(res, hit);
      }
      if (req.url === '/secured') {
        return res.writeHead(authorized ? 200 : 401).end();
      }
      if (req.url === '/moved') {
        return res.writeHead(302, { Location: `${base}/feed` }).end();
      }
      if (req.url === '/hangs') return; // never answers
      res.writeHead(404).end();
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

  it('asks with a HEAD and never requests the feed', async () => {
    await expect(client.probe({ url: `${base}/feed` }, 2000)).resolves.toBe(true);

    expect(hits.map((h) => h.method)).toEqual(['HEAD']);
  });

  it('drops the body of the GET it falls back to when HEAD is not allowed', async () => {
    const startedAt = Date.now();

    await expect(client.probe({ url: `${base}/feed-without-head` }, 5000)).resolves.toBe(true);

    // The whole feed takes FEED_CHUNKS * 10 ms to stream: the probe returns on the headers.
    expect(Date.now() - startedAt).toBeLessThan(FEED_CHUNKS * 10);
    expect(hits.map((h) => h.method)).toEqual(['HEAD', 'GET']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hits[1]?.feedCompleted).toBe(false);
  });

  it('is healthy only when the endpoint accepts the credentials', async () => {
    const url = `${base}/secured`;

    await expect(
      client.probe({ url, auth: { type: 'bearer', token: 'good-token' } }, 2000),
    ).resolves.toBe(true);
    await expect(
      client.probe({ url, auth: { type: 'bearer', token: 'wrong-token' } }, 2000),
    ).resolves.toBe(false);
    await expect(client.probe({ url }, 2000)).resolves.toBe(false);
  });

  it('follows no redirect', async () => {
    await expect(client.probe({ url: `${base}/moved` }, 2000)).resolves.toBe(false);

    expect(hits.map((h) => h.path)).toEqual(['/moved']);
  });

  it('gives up after its timeout', async () => {
    const startedAt = Date.now();

    await expect(client.probe({ url: `${base}/hangs` }, 200)).rejects.toThrow();

    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  it('checks that a local file exists without reading it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-hr-probe-'));
    const file = path.join(dir, 'users.json');
    fs.writeFileSync(file, 'not even json');
    const previous = process.env.JSON_HR_ALLOWED_DIR;
    process.env.JSON_HR_ALLOWED_DIR = dir;
    try {
      await expect(client.probe({ url: file }, 2000)).resolves.toBe(true);
      await expect(client.probe({ url: path.join(dir, 'missing.json') }, 2000)).resolves.toBe(
        false,
      );
    } finally {
      if (previous === undefined) delete process.env.JSON_HR_ALLOWED_DIR;
      else process.env.JSON_HR_ALLOWED_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
