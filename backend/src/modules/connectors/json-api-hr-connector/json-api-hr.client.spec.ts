import { BadRequestException } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonApiHrClient } from './json-api-hr.client';

jest.mock('axios');

// Avoid DNS resolution in tests; isLocalFileAllowed keeps its real behaviour.
jest.mock('@infrastructure/url-validation/ssrf-guard', () => ({
  ...jest.requireActual('@infrastructure/url-validation/ssrf-guard'),
  validateUrlForFetch: jest.fn().mockResolvedValue(undefined),
}));

const mockedAxios = axios as jest.MockedFunction<typeof axios>;
const URL = 'https://hr.example.com/api/users';

describe('JsonApiHrClient', () => {
  let client: JsonApiHrClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.mockResolvedValue({ data: [{ email: 'ada@example.com' }] } as never);
    client = new JsonApiHrClient();
  });

  // From package R's report (json-api-hr.client.ts:58-61): ingest sent a stored `method` as it
  // was (PATCH /connectors accepts any key), so a config could make every scheduled sync send
  // PUT, PATCH or DELETE to the HR system with its credentials. The feed is read with GET only.
  it.each(['PUT', 'post', 'DELETE', 'PATCH'])(
    'refuses method %s and sends nothing',
    async (method) => {
      await expect(client.fetch({ url: URL, method })).rejects.toThrow(
        /reads the feed with GET only/,
      );
      await expect(client.probe({ url: URL, method }, 1000)).rejects.toThrow(
        /reads the feed with GET only/,
      );
      expect(mockedAxios).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, '', 'GET', 'get'])(
    'reads the feed with GET for method %p',
    async (method) => {
      await client.fetch({ url: URL, method });

      expect((mockedAxios.mock.calls[0][0] as unknown as { method: string }).method).toBe('GET');
    },
  );

  it('sends no auth headers and does not follow redirects without auth', async () => {
    await client.fetch({ url: URL });

    const request = mockedAxios.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(request.headers).toBeUndefined();
    expect(request.maxRedirects).toBe(0);
  });

  it('sends a bearer token and does not follow redirects', async () => {
    await client.fetch({ url: URL, auth: { type: 'bearer', token: 's3cret-token' } });

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { Authorization: 'Bearer s3cret-token' },
        maxRedirects: 0,
      }),
    );
  });

  it('sends a custom auth header', async () => {
    await client.fetch({
      url: URL,
      auth: { type: 'header', name: 'X-API-Key', value: 'k-123' },
    });

    expect(mockedAxios).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'X-API-Key': 'k-123' }, maxRedirects: 0 }),
    );
  });

  it('rejects an invalid header name before any request', async () => {
    await expect(
      client.fetch({ url: URL, auth: { type: 'header', name: 'X-Key: injected', value: 'v' } }),
    ).rejects.toThrow(BadRequestException);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('rejects CR/LF in a credential without echoing it', async () => {
    const promise = client.fetch({
      url: URL,
      auth: { type: 'bearer', token: 'abc\r\nX-Evil: 1' },
    });

    await expect(promise).rejects.toThrow('credential contains invalid characters');
    await expect(promise).rejects.not.toThrow(/X-Evil/);
    expect(mockedAxios).not.toHaveBeenCalled();
  });

  it('still reads local files (auth is not used for them)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'json-hr-'));
    const file = path.join(dir, 'users.json');
    fs.writeFileSync(file, JSON.stringify([{ email: 'local@example.com' }]));
    const previous = process.env.JSON_HR_ALLOWED_DIR;
    process.env.JSON_HR_ALLOWED_DIR = dir;
    try {
      const data = await client.fetch({ url: file, auth: { type: 'bearer', token: 't' } });

      expect(data).toEqual([{ email: 'local@example.com' }]);
      expect(mockedAxios).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.JSON_HR_ALLOWED_DIR;
      else process.env.JSON_HR_ALLOWED_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
