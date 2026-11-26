/**
 * Shared Temporal configuration. Single source of truth for address, namespace, mTLS and UI URL.
 * TEMPORAL_ADDRESS and TEMPORAL_UI_URL must be set via environment variables in production.
 */
import { existsSync, readFileSync } from 'fs';

const isProduction = process.env.NODE_ENV === 'production';

export const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

/**
 * The namespace every Temporal client and worker uses: the API's client
 * (temporal-client.provider.ts), the worker and the worker's schedule clients (worker.ts).
 * They must agree: a workflow started in one namespace runs only on a worker polling that one.
 */
export function temporalNamespace(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEMPORAL_NAMESPACE?.trim() || 'default';
}

export const TEMPORAL_NAMESPACE = temporalNamespace();

/** Client certificate pair and server CA for mTLS to Temporal; the shape both connections take. */
export interface TemporalTlsConfig {
  clientCertPair: { crt: Buffer; key: Buffer };
  serverRootCACertificate: Buffer;
}

/**
 * The mTLS settings of every Temporal connection, the API's client and the worker's: the files
 * TEMPORAL_TLS_CERT_PATH, TEMPORAL_TLS_KEY_PATH and TEMPORAL_TLS_CA_PATH name. Without all three
 * set, or with one of the files missing, there are none and the connection is plain.
 */
export function temporalTlsConfig(
  env: NodeJS.ProcessEnv = process.env,
): TemporalTlsConfig | undefined {
  const certPath = env.TEMPORAL_TLS_CERT_PATH;
  const keyPath = env.TEMPORAL_TLS_KEY_PATH;
  const caPath = env.TEMPORAL_TLS_CA_PATH;
  if (!certPath || !keyPath || !caPath) return undefined;
  if (!existsSync(certPath) || !existsSync(keyPath) || !existsSync(caPath)) return undefined;
  return {
    clientCertPair: { crt: readFileSync(certPath), key: readFileSync(keyPath) },
    serverRootCACertificate: readFileSync(caPath),
  };
}

/**
 * The API client's reconnect backoff (temporal-client.provider.ts) when Temporal cannot be
 * reached: the first delay TEMPORAL_RECONNECT_MIN_MS (1000), doubled after each failed attempt up
 * to TEMPORAL_RECONNECT_MAX_MS (30000). A value that is not a positive number takes the default.
 */
export function temporalReconnectDelays(env: NodeJS.ProcessEnv = process.env): {
  minMs: number;
  maxMs: number;
} {
  const positive = (raw: string | undefined, fallback: number) => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const minMs = positive(env.TEMPORAL_RECONNECT_MIN_MS, 1000);
  return { minMs, maxMs: Math.max(minMs, positive(env.TEMPORAL_RECONNECT_MAX_MS, 30000)) };
}

export const TEMPORAL_UI_URL =
  process.env.TEMPORAL_UI_URL || (isProduction ? '' : 'http://localhost:8233');

if (!process.env.TEMPORAL_UI_URL && isProduction) {
  // eslint-disable-next-line no-console
  console.warn(
    '[CONFIG] TEMPORAL_UI_URL is not set. Workflow tracking URLs will be empty in API responses. ' +
      'Set TEMPORAL_UI_URL to your Temporal UI address (e.g. https://temporal.example.com).',
  );
}

/** A workflow's page in the Temporal UI (an API response's trackingUrl), in TEMPORAL_NAMESPACE. */
export function temporalWorkflowUrl(
  workflowId: string,
  uiUrl: string = TEMPORAL_UI_URL,
  namespace: string = TEMPORAL_NAMESPACE,
): string {
  return `${uiUrl}/namespaces/${namespace}/workflows/${workflowId}`;
}
