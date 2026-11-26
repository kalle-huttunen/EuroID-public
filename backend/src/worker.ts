// OTel MUST be initialized before any instrumented libraries (HTTP, MongoDB) are loaded.
import { traceExporter } from './infrastructure/observability/tracing';

import { AppModule } from './app.module';
import { createWorkerContext } from './worker-context';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import { HrActivities } from './activities/hr.activities';
import { IdentityActivities } from './activities/identity.activities';
import { EntraActivities } from './activities/entra.activities';
import { BulkProvisioningActivities } from './activities/bulk-provisioning.activities';
import { RateLimiterActivities } from './activities/rate-limiter.activities';
import { DistributedTransactionActivities } from './activities/distributed-transaction.activities';
import { ReconciliationActivities } from './activities/reconciliation.activities';
import { PolicyActivities } from './activities/policy.activities';
import { ConfigActivities } from './activities/config.activities';
import { AccessReviewActivities } from './activities/access-review.activities';
import {
  AccessReviewRevocationActivities,
  accessReviewRevocationQueueActivities,
} from './activities/access-review-revocation.activities';
import { WritebackActivities } from './activities/writeback.activities';
import { PipelineActivities } from './activities/pipeline.activities';
import { ScheduledSyncActivities } from './activities/scheduled-sync.activities';
import { ArchivalActivities } from './activities/archival.activities';
import { EntitlementExpiryActivities } from './activities/entitlement-expiry.activities';
import { PrivilegedAccessActivities } from './activities/privileged-access.activities';
import { AccessRequestActivities } from './activities/access-request.activities';
import { RiskScoreActivities } from './activities/risk-score.activities';
import { RecertificationActivities } from './activities/recertification.activities';
import { OrphanActivities } from './activities/orphan.activities';
import { IntelligenceActivities } from './activities/intelligence.activities';
import { AuditArchiveActivities } from './activities/audit-archive.activities';
import { CredentialActivities } from './activities/credential.activities';
import { MoverActivities } from './activities/mover.activities';
import {
  MoverAccessActivities,
  moverAccessQueueActivities,
} from './activities/mover-access.activities';
import { CredentialRotationActivities } from './activities/credential-rotation.activities';
import { GitHubActivities } from './activities/github.activities';
import { ServiceNowActivities } from './activities/servicenow.activities';
import { OffboardingActivities } from './activities/offboarding.activities';
import { NoAccountTargetActivities } from './activities/no-account-target.activities';
import { PluginRegistryService } from './modules/connectors/plugin/plugin-registry.service';
import { buildDefaultActivities } from './worker-default-activities';
import { DEFAULT_PROVISIONING_QUEUE } from './infrastructure/temporal/task-queue.config';
import {
  TEMPORAL_ADDRESS,
  TEMPORAL_NAMESPACE,
  temporalTlsConfig,
} from './infrastructure/config/temporal.config';
import { ARCHIVAL_BATCH_SIZE } from './infrastructure/config/defaults';
import {
  OpenTelemetryActivityInboundInterceptor,
  OpenTelemetryActivityOutboundInterceptor,
} from '@temporalio/interceptors-opentelemetry/lib/worker';
import { RateLimitActivityInterceptor } from './infrastructure/temporal/rate-limit-activity.interceptor';
import { EncryptionService } from './infrastructure/secrets/encryption.service';
import { temporalDataConverter } from './infrastructure/temporal/temporal-payload-codec';
import { syncOptionalSchedule, upsertSchedule } from './infrastructure/temporal/schedule-upsert';
import type { Workflow } from '@temporalio/common';
import * as path from 'path';
import { Logger } from '@nestjs/common';

async function run() {
  // Logs through the API's winston configuration: PII keys redacted (worker-context.ts)
  const app = await createWorkerContext(AppModule);
  // Encrypts every payload the workers and schedule clients write (temporal-payload-codec.ts)
  const dataConverter = temporalDataConverter(app.get(EncryptionService));

  const hrActivities = app.get(HrActivities);
  const identityActivities = app.get(IdentityActivities);
  const entraActivities = app.get(EntraActivities);
  const bulkProvisioningActivities = app.get(BulkProvisioningActivities);
  const rateLimiterActivities = app.get(RateLimiterActivities);
  const distributedTxActivities = app.get(DistributedTransactionActivities);
  const reconciliationActivities = app.get(ReconciliationActivities);
  const policyActivities = app.get(PolicyActivities);
  const configActivities = app.get(ConfigActivities);
  const accessReviewActivities = app.get(AccessReviewActivities);
  const accessReviewRevocationActivities = app.get(AccessReviewRevocationActivities);
  const writebackActivities = app.get(WritebackActivities);
  const pipelineActivities = app.get(PipelineActivities);
  const scheduledSyncActivities = app.get(ScheduledSyncActivities);
  const archivalActivities = app.get(ArchivalActivities);
  const entitlementExpiryActivities = app.get(EntitlementExpiryActivities);
  const privilegedAccessActivities = app.get(PrivilegedAccessActivities);
  const accessRequestActivities = app.get(AccessRequestActivities);
  const riskScoreActivities = app.get(RiskScoreActivities);
  const recertificationActivities = app.get(RecertificationActivities);
  const orphanActivities = app.get(OrphanActivities);
  const intelligenceActivities = app.get(IntelligenceActivities);
  const auditArchiveActivities = app.get(AuditArchiveActivities);
  const credentialActivities = app.get(CredentialActivities);
  const moverActivities = app.get(MoverActivities);
  const credentialRotationActivities = app.get(CredentialRotationActivities);
  const githubActivities = app.get(GitHubActivities);
  const serviceNowActivities = app.get(ServiceNowActivities);
  const offboardingActivities = app.get(OffboardingActivities);
  const noAccountTargetActivities = app.get(NoAccountTargetActivities);

  const context = {
    hr: hrActivities,
    identity: identityActivities,
    entra: entraActivities,
    bulk: bulkProvisioningActivities,
    rateLimiter: rateLimiterActivities,
    distributedTx: distributedTxActivities,
    reconciliation: reconciliationActivities,
    policy: policyActivities,
    config: configActivities,
    accessReview: accessReviewActivities,
    accessReviewRevocation: accessReviewRevocationActivities,
    writeback: writebackActivities,
    pipeline: pipelineActivities,
    scheduledSync: scheduledSyncActivities,
    archival: archivalActivities,
    entitlementExpiry: entitlementExpiryActivities,
    privilegedAccess: privilegedAccessActivities,
    accessRequest: accessRequestActivities,
    riskScore: riskScoreActivities,
    recertification: recertificationActivities,
    orphan: orphanActivities,
    intelligence: intelligenceActivities,
    auditArchive: auditArchiveActivities,
    credential: credentialActivities,
    mover: moverActivities,
    credentialRotation: credentialRotationActivities,
    github: githubActivities,
    serviceNow: serviceNowActivities,
    offboarding: offboardingActivities,
    noAccountTargets: noAccountTargetActivities,
  };

  // The same mTLS settings as the API's client (temporal-client.provider.ts)
  const tlsConfig = temporalTlsConfig();

  const workerLogger = new Logger('TemporalWorker');
  if (tlsConfig) {
    workerLogger.log('Temporal mTLS enabled (client certificates)');
  }

  const connection = await NativeConnection.connect({
    address: TEMPORAL_ADDRESS,
    ...(tlsConfig && { tls: tlsConfig }),
  });

  let workflowBundle;
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    workerLogger.log('Loading pre-built workflow bundle from dist/');
    workflowBundle = {
      codePath: path.join(__dirname, 'workflow-bundle.js'),
    };
  } else {
    workerLogger.log('Bundling workflows dynamically from src/ (Hot Reload Mode)');
    const { code } = await bundleWorkflowCode({
      workflowsPath: path.join(__dirname, 'workflows'),
    });
    workflowBundle = { code };
  }

  const workerConfigBase: Record<string, unknown> = {
    connection,
    namespace: TEMPORAL_NAMESPACE,
    workflowBundle,
  };
  // Activity interceptors: rate limit 429 handling (always) + OpenTelemetry (when enabled)
  const activityInterceptors: Array<
    (ctx: import('@temporalio/activity').Context) => { inbound: unknown; outbound: unknown }
  > = [
    () => ({
      inbound: new RateLimitActivityInterceptor(),
      outbound: {},
    }),
  ];
  if (traceExporter) {
    activityInterceptors.push((ctx: import('@temporalio/activity').Context) => ({
      inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
      outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
    }));
  }
  workerConfigBase.interceptors = { activity: activityInterceptors };
  workerConfigBase.dataConverter = dataConverter;

  // Option A: Single process subscribes to all queues (simpler for dev)
  // Each worker listens to its own queue; activities run on the connector-specific queue when routed
  const workers: Worker[] = [];

  // 1. Default queue — workflows + all generic + fallback connector activities
  const defaultWorker = await Worker.create({
    ...workerConfigBase,
    taskQueue: DEFAULT_PROVISIONING_QUEUE,
    activities: buildDefaultActivities(context),
  });
  workers.push(defaultWorker);

  // 2. Connector-specific queues — from plugin registry (bulkhead isolation)
  const registry = app.get(PluginRegistryService);
  const connectors = registry.getAll();
  // Access review revocation and the mover's access change run on the connector's own queue,
  // next to its plugin activities
  const queueExtras = [
    accessReviewRevocationQueueActivities(accessReviewRevocationActivities),
    moverAccessQueueActivities(app.get(MoverAccessActivities)),
  ];
  for (const manifest of connectors) {
    if (manifest.taskQueue && manifest.activityClass && manifest.activityBindings) {
      const activityInstance = app.get(manifest.activityClass);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic activity binding from plugin manifest requires flexible function types
      const activities: Record<string, (...args: any[]) => Promise<any>> = {};
      for (const [name, method] of Object.entries(manifest.activityBindings)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic method lookup on plugin activity instance
        const fn = (activityInstance as Record<string, any>)[method];
        if (typeof fn === 'function') {
          activities[name] = fn.bind(activityInstance);
        }
      }
      for (const extras of queueExtras) Object.assign(activities, extras[manifest.taskQueue]);
      const worker = await Worker.create({
        ...workerConfigBase,
        taskQueue: manifest.taskQueue,
        activities,
      });
      workers.push(worker);
      workerLogger.log(`[plugin] ${manifest.taskQueue}: ${manifest.name} activities`);
    }
  }

  workerLogger.log('Temporal Workers (Bulkhead Pattern) — per-connector task queues');
  workerLogger.log(`${DEFAULT_PROVISIONING_QUEUE}: workflows + generic + fallback`);
  for (const manifest of connectors) {
    if (manifest.taskQueue && manifest.activityClass && manifest.activityBindings) {
      workerLogger.log(`${manifest.taskQueue}: ${manifest.name} activities`);
    }
  }
  workerLogger.log('Ready to process with fault isolation');

  // The worker's schedules: created when missing, otherwise updated, so a changed cron env var
  // applies and the stored action args are encoded again under the current encryption key
  // (schedule-upsert.ts; key rotation step 2 relies on it).
  const scheduled = await import('./worker-scheduled-workflows');
  const schedules = new Client({ connection, namespace: TEMPORAL_NAMESPACE, dataConverter })
    .schedule;
  const scheduleLogger = {
    log: (m: string) => workerLogger.log(m),
    warn: (m: string) => workerLogger.warn(m),
  };
  const ensureSchedule = (
    scheduleId: string,
    cron: string,
    workflowType: Workflow,
    args: unknown[] = [{}],
  ) =>
    upsertSchedule(
      schedules,
      {
        scheduleId,
        spec: { cronExpressions: [cron] },
        action: {
          type: 'startWorkflow',
          workflowType,
          args,
          taskQueue: DEFAULT_PROVISIONING_QUEUE,
        },
      },
      scheduleLogger,
    );

  await ensureSchedule(
    'entitlement-expiry-hourly',
    '0 * * * *',
    scheduled.entitlementExpiryWorkflow,
  );
  await ensureSchedule(
    'recertification-scheduler-daily',
    process.env.RECERTIFICATION_CRON ?? '0 2 * * *',
    scheduled.recertificationSchedulerWorkflow,
  );
  await ensureSchedule(
    'risk-score-calculation-daily',
    process.env.RISK_SCORE_CRON ?? '0 2 * * *',
    scheduled.riskScoreCalculationWorkflow,
  );
  // Nightly at 4 AM by default, after risk scoring
  await ensureSchedule(
    'intelligence-batch-daily',
    process.env.INTELLIGENCE_BATCH_CRON ?? '0 4 * * *',
    scheduled.intelligenceBatchWorkflow,
  );
  // Optional jobs: a job turned off has its schedule paused, and resumed once it is on again
  // (syncOptionalSchedule); before, turning one off left its schedule running.
  const optionalSchedule = (
    scheduleId: string,
    cron: string,
    workflowType: Workflow,
    args: unknown[],
    job: { enabled: true } | { enabled: false; reason: string },
  ) =>
    syncOptionalSchedule(
      schedules,
      {
        scheduleId,
        spec: { cronExpressions: [cron] },
        action: {
          type: 'startWorkflow',
          workflowType,
          args,
          taskQueue: DEFAULT_PROVISIONING_QUEUE,
        },
      },
      job,
      scheduleLogger,
    );

  await optionalSchedule(
    'audit-archive-daily',
    process.env.AUDIT_ARCHIVE_CRON ?? '0 3 * * *',
    scheduled.auditArchiveWorkflow,
    [{}],
    process.env.AUDIT_ARCHIVE_ENABLED === 'true'
      ? { enabled: true }
      : { enabled: false, reason: 'AUDIT_ARCHIVE_ENABLED is not true' },
  );

  // Cold-storage archival (audit + user events: export, then delete) if enabled. Separate from
  // audit-archive above: that exports Merkle checkpoints to WORM S3 and deletes nothing.
  const storageProvider = process.env.ARCHIVAL_STORAGE_PROVIDER;
  const archivalEnabled = process.env.ARCHIVAL_ENABLED === 'true';
  if (archivalEnabled && !storageProvider) {
    workerLogger.warn('ARCHIVAL_ENABLED=true but ARCHIVAL_STORAGE_PROVIDER is unset; skipping');
  }
  await optionalSchedule(
    'archival-nightly',
    process.env.ARCHIVAL_CRON ?? '0 2 * * *',
    scheduled.archivalWorkflow,
    [
      {
        collections: ['audit_events', 'user_events'],
        cutoffDays: {
          audit_events: parseInt(process.env.AUDIT_RETENTION_DAYS ?? '365', 10),
          user_events: parseInt(process.env.USER_EVENTS_RETENTION_DAYS ?? '365', 10),
        },
        storageConfig: {
          provider: storageProvider,
          bucket: process.env.ARCHIVAL_STORAGE_BUCKET,
          container: process.env.ARCHIVAL_STORAGE_CONTAINER,
          region: process.env.ARCHIVAL_STORAGE_REGION,
        },
        batchSize: ARCHIVAL_BATCH_SIZE,
      },
    ],
    archivalEnabled && storageProvider
      ? { enabled: true }
      : {
          enabled: false,
          reason: archivalEnabled
            ? 'ARCHIVAL_STORAGE_PROVIDER is unset'
            : 'ARCHIVAL_ENABLED is not true',
        },
  );

  await ensureSchedule(
    'credential-rotation-nightly',
    process.env.CREDENTIAL_ROTATION_CRON ?? '0 3 * * *',
    scheduled.credentialRotationWorkflow,
  );

  await Promise.all(workers.map((w) => w.run()));
}

run().catch((err) => {
  new Logger('TemporalWorker').error(
    'Worker failed',
    err instanceof Error ? err.stack : String(err),
  );
  process.exit(1);
});

// --- TASK_103 recap: RateLimitActivityInterceptor (429 → nextRetryDelay), updateFromExternalSignal in activities.
// --- Task 108 recap: ArchivalActivities registered — findDocumentsForArchival, exportBatchToStorage, deleteArchivedBatch, recordArchivalMetadata.
