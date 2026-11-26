/**
 * OpenTelemetry tracing bootstrap.
 *
 * MUST be imported first (before any other application code) in main.ts and worker.ts.
 * OTel must initialize before instrumented libraries (HTTP, MongoDB, etc.) are loaded.
 *
 * Graceful degradation: Set OTEL_SDK_DISABLED=true to disable tracing entirely.
 * If the OTLP exporter is unreachable, the SDK continues—spans may be dropped.
 *
 * Exports sdk, resource, traceExporter for Temporal worker interceptors (when enabled).
 */

 
import { resolve } from 'path';
import { existsSync } from 'fs';

// Load .env before reading OTEL_* (same path order as main.ts)
// __dirname: dist/common/tracing (prod) or src/common/tracing (dev)
const backendDir = resolve(__dirname, '..', '..', '..');
const envPaths = [
  resolve(backendDir, '.env'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'backend', '.env'),
].filter((p) => existsSync(p));
if (envPaths[0]) {
  try {
    require('dotenv').config({ path: envPaths[0] });
  } catch {
    // Ignore
  }
}

const disabled = process.env.OTEL_SDK_DISABLED === 'true';

// Exported for worker shutdown (otelSdk) and Temporal interceptors (resource, traceExporter)
export let otelSdk: { start: () => void; shutdown: () => Promise<void> } | undefined;
export let resource: { attributes: Record<string, unknown> } | undefined;
export let traceExporter: { export: (spans: unknown[]) => Promise<unknown>; shutdown: () => Promise<void> } | undefined;

if (disabled) {
  // Tracing disabled — no log to avoid console in production
} else {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
  const { MongoDBInstrumentation } = require('@opentelemetry/instrumentation-mongodb');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

  const serviceName = process.env.OTEL_SERVICE_NAME || 'euroid-backend';
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

  traceExporter = new OTLPTraceExporter({
    url: endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`,
  });

  resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  });

  otelSdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new MongoDBInstrumentation(),
    ],
  });

  otelSdk?.start();
}
