import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  TEMPORAL_NAMESPACE,
  TEMPORAL_UI_URL,
  temporalNamespace,
  temporalReconnectDelays,
  temporalTlsConfig,
  temporalWorkflowUrl,
} from './temporal.config';

describe('temporalNamespace', () => {
  it('reads TEMPORAL_NAMESPACE', () => {
    expect(temporalNamespace({ TEMPORAL_NAMESPACE: 'euroid-prod' })).toBe('euroid-prod');
    expect(temporalNamespace({ TEMPORAL_NAMESPACE: ' euroid-prod ' })).toBe('euroid-prod');
  });

  it('is `default` when TEMPORAL_NAMESPACE is unset or empty, as Temporal names it', () => {
    expect(temporalNamespace({})).toBe('default');
    expect(temporalNamespace({ TEMPORAL_NAMESPACE: '' })).toBe('default');
    expect(temporalNamespace({ TEMPORAL_NAMESPACE: '   ' })).toBe('default');
  });
});

describe('temporalWorkflowUrl', () => {
  // Tracking links named the namespace `default` whatever TEMPORAL_NAMESPACE was, so with another
  // namespace every link opened a workflow the Temporal UI could not find.
  it("links the workflow's page in the given namespace", () => {
    expect(
      temporalWorkflowUrl('t-acme-onboard-6741c0f2', 'https://temporal.example.com', 'euroid-prod'),
    ).toBe('https://temporal.example.com/namespaces/euroid-prod/workflows/t-acme-onboard-6741c0f2');
  });

  it('defaults to TEMPORAL_UI_URL and TEMPORAL_NAMESPACE', () => {
    expect(temporalWorkflowUrl('wf-1')).toBe(
      `${TEMPORAL_UI_URL}/namespaces/${TEMPORAL_NAMESPACE}/workflows/wf-1`,
    );
  });
});

describe('temporalTlsConfig', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'temporal-tls-'));
    writeFileSync(join(dir, 'client.pem'), 'client certificate');
    writeFileSync(join(dir, 'client-key.pem'), 'client key');
    writeFileSync(join(dir, 'ca.pem'), 'server CA');
    env = {
      TEMPORAL_TLS_CERT_PATH: join(dir, 'client.pem'),
      TEMPORAL_TLS_KEY_PATH: join(dir, 'client-key.pem'),
      TEMPORAL_TLS_CA_PATH: join(dir, 'ca.pem'),
    };
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the client certificate pair and the server CA when all three files exist', () => {
    expect(temporalTlsConfig(env)).toEqual({
      clientCertPair: { crt: Buffer.from('client certificate'), key: Buffer.from('client key') },
      serverRootCACertificate: Buffer.from('server CA'),
    });
  });

  it('is none (a plain connection) unless all three paths are set', () => {
    expect(temporalTlsConfig({})).toBeUndefined();
    for (const missing of Object.keys(env)) {
      expect(temporalTlsConfig({ ...env, [missing]: undefined })).toBeUndefined();
      expect(temporalTlsConfig({ ...env, [missing]: '' })).toBeUndefined();
    }
  });

  it('is none when one of the files does not exist, as the worker always treated it', () => {
    for (const missing of Object.keys(env)) {
      expect(temporalTlsConfig({ ...env, [missing]: join(dir, 'absent.pem') })).toBeUndefined();
    }
  });
});

describe('temporalReconnectDelays', () => {
  it('defaults to 1 s doubling up to 30 s', () => {
    expect(temporalReconnectDelays({})).toEqual({ minMs: 1000, maxMs: 30000 });
  });

  it('reads TEMPORAL_RECONNECT_MIN_MS and TEMPORAL_RECONNECT_MAX_MS, ignoring values that are not positive', () => {
    expect(
      temporalReconnectDelays({
        TEMPORAL_RECONNECT_MIN_MS: '500',
        TEMPORAL_RECONNECT_MAX_MS: '8000',
      }),
    ).toEqual({ minMs: 500, maxMs: 8000 });
    expect(
      temporalReconnectDelays({
        TEMPORAL_RECONNECT_MIN_MS: '0',
        TEMPORAL_RECONNECT_MAX_MS: 'soon',
      }),
    ).toEqual({ minMs: 1000, maxMs: 30000 });
    // A maximum below the minimum is the minimum.
    expect(
      temporalReconnectDelays({
        TEMPORAL_RECONNECT_MIN_MS: '5000',
        TEMPORAL_RECONNECT_MAX_MS: '100',
      }),
    ).toEqual({ minMs: 5000, maxMs: 5000 });
  });
});
