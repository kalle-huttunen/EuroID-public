/**
 * The API's Temporal client and the worker connect with the same settings, all read in
 * infrastructure/config/temporal.config.ts.
 *
 * - Namespace: the worker polled TEMPORAL_NAMESPACE (default `default`) while the API's client
 *   and the worker's schedule clients set none and so always used `default`. With
 *   TEMPORAL_NAMESPACE set, the API started workflows in a namespace no worker polled.
 * - mTLS: only the worker read TEMPORAL_TLS_CERT_PATH / KEY / CA, so on an mTLS-only Temporal
 *   (Temporal Cloud) the API could not connect and started no workflows.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { EncryptionService } from '../secrets/encryption.service';

jest.mock('@temporalio/client', () => ({
  Connection: { connect: jest.fn() },
  Client: jest.fn(),
}));

const TEMPORAL_ENV = [
  'TEMPORAL_NAMESPACE',
  'TEMPORAL_TLS_CERT_PATH',
  'TEMPORAL_TLS_KEY_PATH',
  'TEMPORAL_TLS_CA_PATH',
] as const;

describe('TemporalClientProvider', () => {
  const saved = Object.fromEntries(TEMPORAL_ENV.map((k) => [k, process.env[k]]));
  let certDir: string;

  beforeAll(() => {
    certDir = mkdtempSync(join(tmpdir(), 'temporal-tls-'));
    writeFileSync(join(certDir, 'client.pem'), 'client certificate');
    writeFileSync(join(certDir, 'client-key.pem'), 'client key');
    writeFileSync(join(certDir, 'ca.pem'), 'server CA');
  });

  afterAll(() => rmSync(certDir, { recursive: true, force: true }));

  afterEach(() => {
    for (const k of TEMPORAL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    jest.resetModules();
  });

  /** What the provider passes to Connection.connect and new Client(), with this environment. */
  async function connectWith(env: Partial<Record<(typeof TEMPORAL_ENV)[number], string>>) {
    for (const k of TEMPORAL_ENV) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    // Fresh modules read the environment again; the mocked client module is shared.
    jest.resetModules();
    const temporal = jest.requireMock<{ Client: jest.Mock; Connection: { connect: jest.Mock } }>(
      '@temporalio/client',
    );
    const connection = { address: 'temporal:7233' };
    temporal.Connection.connect.mockReset().mockResolvedValue(connection);
    temporal.Client.mockClear();
    const { TemporalClientProvider } =
      (await import('./temporal-client.provider')) as typeof import('./temporal-client.provider');
    // The payload codec reads its keys only when it encodes: these tests check the connection
    await new TemporalClientProvider({} as EncryptionService).onModuleInit();
    expect(temporal.Connection.connect).toHaveBeenCalledTimes(1);
    expect(temporal.Client).toHaveBeenCalledTimes(1);
    return {
      connectOptions: temporal.Connection.connect.mock.calls[0][0],
      clientOptions: temporal.Client.mock.calls[0][0],
      connection,
    };
  }

  it('starts workflows in the namespace the worker polls', async () => {
    const { clientOptions, connection } = await connectWith({ TEMPORAL_NAMESPACE: 'euroid-prod' });
    expect(clientOptions).toEqual({
      connection,
      namespace: 'euroid-prod',
      dataConverter: expect.anything(),
    });
  });

  it('uses `default` when TEMPORAL_NAMESPACE is not set', async () => {
    const { clientOptions } = await connectWith({});
    expect(clientOptions.namespace).toBe('default');
  });

  it("connects with the worker's mTLS client certificate and CA", async () => {
    const { connectOptions } = await connectWith({
      TEMPORAL_TLS_CERT_PATH: join(certDir, 'client.pem'),
      TEMPORAL_TLS_KEY_PATH: join(certDir, 'client-key.pem'),
      TEMPORAL_TLS_CA_PATH: join(certDir, 'ca.pem'),
    });
    expect(connectOptions.tls).toEqual({
      clientCertPair: { crt: Buffer.from('client certificate'), key: Buffer.from('client key') },
      serverRootCACertificate: Buffer.from('server CA'),
    });
  });

  it('connects without TLS when the certificate paths are not set', async () => {
    const { connectOptions } = await connectWith({});
    expect(connectOptions).not.toHaveProperty('tls');
  });
});

describe('worker.ts', () => {
  const source = readFileSync(resolve(__dirname, '../../worker.ts'), 'utf8');

  it('takes namespace and mTLS from the shared config', () => {
    expect(source).toMatch(
      /import \{[^}]*\bTEMPORAL_NAMESPACE\b[^}]*\btemporalTlsConfig\b[^}]*\} from '\.\/infrastructure\/config\/temporal\.config'/,
    );
    expect(source).toContain('namespace: TEMPORAL_NAMESPACE,');
    expect(source).toContain('temporalTlsConfig()');
    expect(source).not.toMatch(/process\.env\.TEMPORAL_(NAMESPACE|TLS_)/);
  });

  it('creates its schedules in that namespace too', () => {
    const clients = source.match(/new Client\(\{[^}]*\}\)/g) ?? [];
    expect(clients.length).toBeGreaterThan(0);
    for (const call of clients) expect(call).toContain('namespace: TEMPORAL_NAMESPACE');
  });
});
