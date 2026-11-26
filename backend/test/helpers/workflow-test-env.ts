/**
 * Thin wrapper around @temporalio/testing so workflow e2e tests stay short.
 *
 * Spins up an in-process time-skipping Temporal test server, a Worker with
 * the supplied workflow bundle + mocked activities, and returns a client
 * you can use to start workflows.
 *
 * Skipped at collection time unless `TEMPORAL_E2E=1` is set — the server
 * binary (~100MB) is downloaded on first use, which we don't want on every
 * developer machine or every CI run.
 *
 * The binary is kept in backend/node_modules/.cache/temporal-test-server (see
 * createTestWorkflowEnvironment), so the pre-push hook needs the network only for the first run.
 *
 * The environment's client and every worker run the payload codec the API and the worker run
 * (test-payload-codec.ts), so the server stores encrypted payloads, as in production.
 */
import * as fs from 'fs';
import * as path from 'path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { ActivityInterceptorsFactory, LogLevel } from '@temporalio/worker';
import { testDataConverter } from './test-payload-codec';

export interface WorkflowTestHarness {
  env: TestWorkflowEnvironment;
  worker: Worker;
  taskQueue: string;
  shutdown: () => Promise<void>;
}

/** An activity-only worker on its own queue, like a connector's bulkhead queue in worker.ts. */
export interface QueueWorkerOptions {
  taskQueue: string;
  activities: Record<string, (...args: unknown[]) => unknown>;
}

export interface WorkflowTestHarnessOptions {
  /** Path to the workflow module — Temporal bundles this for the worker. */
  workflowsPath: string;
  /** Plain object map: activityName → jest.fn (or any async impl). */
  activities: Record<string, (...args: unknown[]) => unknown>;
  /** Activity interceptors, e.g. the worker's RateLimitActivityInterceptor. */
  activityInterceptors?: ActivityInterceptorsFactory[];
  /** Optional override; defaults to "test-queue-<random>". */
  taskQueue?: string;
  /** Log level for the worker; default "ERROR" keeps test output quiet. */
  logLevel?: LogLevel;
  /** Extra activity-only workers, each polling its own task queue. */
  queueWorkers?: QueueWorkerOptions[];
  /**
   * An environment created beforehand, for an app under test that needs the client before its
   * activities exist. The harness owns it from here (shutdown tears it down).
   */
  env?: TestWorkflowEnvironment;
}

/** True when the current run should include TestWorkflowEnvironment tests. */
export const shouldRunTemporalE2E = process.env.TEMPORAL_E2E === '1';

/**
 * Jest helper that skips the describe block unless TEMPORAL_E2E=1. Use this
 * so the suite remains valid when the test server binary isn't available.
 */
export const describeTemporalE2E = shouldRunTemporalE2E ? describe : describe.skip;

/**
 * Where the test server binary is kept: next to mongodb-memory-server's binary, so it survives a
 * reboot. @temporalio/testing's default is the OS temp directory (a tmpfs cleared on reboot on
 * Fedora) with a one-day TTL, after which every run downloaded it again from temporal.download and
 * an offline run failed.
 */
const TEST_SERVER_DIR = path.resolve(__dirname, '../../node_modules/.cache/temporal-test-server');

/**
 * The time-skipping test server. The download is named after the SDK version
 * (temporal-test-server-sdk-typescript-<version>), so an SDK upgrade fetches its own server and a
 * long TTL keeps nothing stale.
 */
export async function createTestWorkflowEnvironment(): Promise<TestWorkflowEnvironment> {
  fs.mkdirSync(TEST_SERVER_DIR, { recursive: true });
  return TestWorkflowEnvironment.createTimeSkipping({
    server: { executable: { type: 'cached-download', downloadDir: TEST_SERVER_DIR, ttl: '365d' } },
    client: { dataConverter: testDataConverter },
  });
}

export async function createWorkflowTestHarness(
  options: WorkflowTestHarnessOptions,
): Promise<WorkflowTestHarness> {
  const env = options.env ?? (await createTestWorkflowEnvironment());
  const taskQueue = options.taskQueue ?? `test-queue-${Math.random().toString(36).slice(2, 10)}`;

  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    workflowsPath: options.workflowsPath,
    activities: options.activities,
    interceptors: { activity: options.activityInterceptors ?? [] },
    dataConverter: testDataConverter,
  });

  const queueWorkers: Worker[] = [];
  for (const queueWorker of options.queueWorkers ?? []) {
    queueWorkers.push(
      await Worker.create({
        connection: env.nativeConnection,
        namespace: env.namespace,
        taskQueue: queueWorker.taskQueue,
        activities: queueWorker.activities,
        dataConverter: testDataConverter,
      }),
    );
  }

  const runPromises = [worker, ...queueWorkers].map((w) => w.run());
  // `logLevel` kept in the interface for future use; worker loggers are configured via Runtime.
  void options.logLevel;

  const shutdown = async (): Promise<void> => {
    for (const w of [worker, ...queueWorkers]) w.shutdown();
    await Promise.all(runPromises);
    await env.teardown();
  };

  return { env, worker, taskQueue, shutdown };
}
