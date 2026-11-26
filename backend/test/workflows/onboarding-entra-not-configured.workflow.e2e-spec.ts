/**
 * Onboarding with an Entra ID target, end to end on the time-skipping Temporal test server, when
 * Entra ID has no config anywhere, only a canvas config, or a config that does not work. Opt-in
 * via TEMPORAL_E2E=1.
 *
 * The real onboardingWorkflow runs on the default queue with stubbed default-queue activities
 * (canvas discovery, the canvas node configs, HR, Hub, policy, identity). The Entra ID queue runs
 * the real isEntraConfigured activity on the real EntraService config pick (the tenant's installed
 * connector config through EntraTenantConfigService, ENTRA_* through ConfigService, both stubbed
 * at their source); its health check is the real activity on the real EntraClient unless a test
 * stubs it, provisioning is a mock. AD on its own queue is the other target.
 *
 * Proves:
 *   - Entra ID with no canvas config, no installed connector config and no ENTRA_* is left out
 *     of the run: no health check, no provisioning, no provisioning entry. AD is provisioned and
 *     the result names Entra ID as skipped because it is not configured.
 *   - With that Entra ID the only target, the run completes and says no target was left.
 *   - Either way the person's identity lookup (getIdentityByEmail) gets the targets left out, which
 *     it puts on the identity timeline (a trailing argument: no new command, no patch).
 *   - Entra ID configured only on its canvas node is checked on that config, the one
 *     provisioning gets, instead of failing the health check on no config.
 *   - Entra ID configured but unhealthy, or with an incomplete installed config, still fails the
 *     run at the health check (HealthCheckFailed) before anything is provisioned.
 *   - A history recorded before the patch onboarding:entra-not-configured (Entra ID health
 *     checked with config undefined) still replays.
 *
 * Fixture test/fixtures/onboarding-pre-entra-not-configured.history.json was recorded with the
 * pre-patch workflow (commit caee2b6f), from backend/:
 *   git show caee2b6f:backend/src/workflows/onboarding.workflow.ts \
 *     > src/workflows/onboarding-pre-entra-not-configured.workflow.ts
 *   TEMPORAL_E2E=1 ONBOARDING_FIXTURE_WORKFLOW=src/workflows/onboarding-pre-entra-not-configured.workflow.ts \
 *     npx jest -c test/jest-e2e.json onboarding-entra-not-configured -t 'records the pre-patch fixture'
 *   rm src/workflows/onboarding-pre-entra-not-configured.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { Worker } from '@temporalio/worker';
import { onboardingWorkflow } from '../../src/workflows/onboarding.workflow';
import { EntraActivities } from '../../src/activities/entra.activities';
import { EntraService } from '../../src/modules/connectors/entra-connector/entra.service';
import { EntraClient } from '../../src/modules/connectors/entra-connector/entra.client';
import { EntraDiscoveryService } from '../../src/modules/connectors/entra-connector/entra-discovery.service';
import { EntraTenantConfigService } from '../../src/modules/connectors/entra-connector/entra-tenant-config.service';
import {
  CorrelationConfigRegistry,
  CONNECTOR_CONFIG_PROVIDER_KEY,
} from '../../src/modules/correlation-config/correlation-config.registry';
import type { IConnectorConfigProvider } from '../../src/modules/correlation-config/correlation-config.interface';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/onboarding.workflow.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/onboarding-pre-entra-not-configured.history.json',
);
const TENANT = 'tenant-a';

const user = {
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  departmentName: 'Engineering',
};
const groupOp = { target: 'all', type: 'group', action: 'add', targetId: 'engineering' };
const CANVAS_ENTRA = { tenantId: 'entra-canvas', clientId: 'app-canvas', clientSecret: 's-c' };
const INSTALLED_ENTRA = { tenantId: 'entra-t1', clientId: 'app-t1', clientSecret: 'secret-t1' };

describeTemporalE2E('onboarding: an Entra ID target that is not configured (e2e)', () => {
  let harness: WorkflowTestHarness;
  const activeTargets = jest.fn();
  /** The canvas nodes' configs (getConnectorConfig); a missing entry is a node without one. */
  let canvasConfigs: Record<string, Record<string, unknown>> = {};
  /** The tenant's installed Entra ID connector config; undefined: none installed. */
  let installedEntra: Record<string, string> | undefined;
  /** The deployment's environment (ENTRA_*). */
  let env: Record<string, string> = {};
  const setProvisioningStatus = jest.fn();
  const getIdentityByEmail = jest.fn();
  const checkEntraHealth = jest.fn();
  const provisionUserToEntra = jest.fn();
  const checkAdHealth = jest.fn();
  const provisionUserToAd = jest.fn();

  // The real EntraService config pick and health check, on stubbed config sources
  const configService = { get: (key: string) => env[key] } as unknown as ConfigService;
  const registry = new CorrelationConfigRegistry();
  registry.register(CONNECTOR_CONFIG_PROVIDER_KEY, {
    getConfig: async (name: string) =>
      name === 'entra-id' && installedEntra ? { config: installedEntra } : null,
  } as unknown as IConnectorConfigProvider);
  // A config that passes the credentials check would reach the token endpoint: tests with one
  // stub the health check
  const client = new EntraClient(
    configService,
    { get: async () => undefined, set: async () => undefined } as never,
    { execute: async () => Promise.reject(new Error('no network in this test')) } as never,
  );
  const entra = new EntraActivities(
    new EntraService(
      new EntraDiscoveryService(client, configService),
      {} as never,
      {} as never,
      client,
      new EntraTenantConfigService(registry),
    ),
    {} as never,
    {} as never,
    {} as never,
  );

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getActiveTargetSystems: (...args: unknown[]) => activeTargets(...args),
      getConnectorConfig: async (id: unknown) => canvasConfigs[id as string] ?? null,
      getEdgeConditions: async () => null,
      getPipelineStatus: async () => 'DEPLOYED',
      recordProvisioningOutcome: async () => undefined,
      fetchNewHires: async () => [user],
      saveToHub: async () => 'identity-1',
      getUserByEmail: async () => user,
      getIdentityByEmail: (...args: unknown[]) => getIdentityByEmail(...args),
      setProvisioningStatus: (...args: unknown[]) => setProvisioningStatus(...args),
      evaluateUser: async () => ({ operations: [groupOp] }),
      // No target excluded by an access review (patch onboarding:review-exclusions)
      getReviewExcludedTargets: async () => [],
      writebackToIdentity: async () => ({ success: true, updatedFields: [] }),
      writebackToHrSource: async () => undefined,
    },
    queueWorkers: [
      {
        taskQueue: 'provisioning-entra',
        activities: {
          isEntraConfigured: (...args: unknown[]) =>
            entra.isEntraConfigured(...(args as Parameters<EntraActivities['isEntraConfigured']>)),
          checkEntraHealth: (...args: unknown[]) => checkEntraHealth(...args),
          provisionUserToEntra: (...args: unknown[]) => provisionUserToEntra(...args),
        },
      },
      {
        taskQueue: 'provisioning-ad',
        activities: {
          checkAdHealth: (...args: unknown[]) => checkAdHealth(...args),
          provisionUserToAd: (...args: unknown[]) => provisionUserToAd(...args),
        },
      },
    ],
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    activeTargets.mockReset().mockResolvedValue(['entra', 'ad']);
    // AD has a canvas config: an AD node without one is left out (onboarding:ad-not-configured)
    canvasConfigs = { ad: { host: 'dc1.corp' } };
    installedEntra = undefined;
    env = {};
    setProvisioningStatus.mockReset().mockResolvedValue(undefined);
    getIdentityByEmail
      .mockReset()
      .mockResolvedValue({ _id: 'identity-1', profile: user, provisioning: [] });
    checkEntraHealth
      .mockReset()
      .mockImplementation((...args: unknown[]) =>
        entra.checkEntraHealth(...(args as Parameters<EntraActivities['checkEntraHealth']>)),
      );
    provisionUserToEntra.mockReset().mockResolvedValue({ success: true, objectId: 'entra-1' });
    checkAdHealth.mockReset().mockResolvedValue(true);
    provisionUserToAd.mockReset().mockResolvedValue({ success: true });
  });

  const run = (id: string) =>
    harness.env.client.workflow.execute(onboardingWorkflow, {
      args: [{ tenantId: TENANT, targetEmail: user.email }],
      taskQueue: harness.taskQueue,
      workflowId: `onboarding-e2e-entra-${id}`,
    });

  const entriesFor = (system: string) =>
    setProvisioningStatus.mock.calls.filter(([, target]) => target === system);

  it('leaves an Entra ID with no config anywhere out of the run and provisions AD', async () => {
    await expect(run('not-configured')).resolves.toBe(
      `Dynamic onboarding complete for ${user.email}. Skipped entra: not configured.`,
    );

    expect(checkEntraHealth).not.toHaveBeenCalled();
    expect(provisionUserToEntra).not.toHaveBeenCalled();
    expect(entriesFor('entra')).toEqual([]);
    // The person's identity lookup gets the target left out, for the identity timeline
    expect(getIdentityByEmail).toHaveBeenCalledWith(
      user.email,
      TENANT,
      'onboarding-e2e-entra-not-configured',
      ['entra'],
    );
    expect(checkAdHealth).toHaveBeenCalledTimes(1);
    expect(provisionUserToAd).toHaveBeenCalledTimes(1);
    expect(entriesFor('ad').map(([, , status]) => status)).toEqual(['SYNCING', 'SYNCED']);
  }, 60_000);

  it('completes and says so when the unconfigured Entra ID is the only target', async () => {
    activeTargets.mockResolvedValue(['entra']);

    await expect(run('only-target')).resolves.toBe(
      `Dynamic onboarding complete for ${user.email}. Skipped entra: not configured. ` +
        'No target left to provision.',
    );

    expect(checkEntraHealth).not.toHaveBeenCalled();
    expect(provisionUserToEntra).not.toHaveBeenCalled();
    expect(setProvisioningStatus).not.toHaveBeenCalled();
    expect(getIdentityByEmail).toHaveBeenCalledWith(
      user.email,
      TENANT,
      'onboarding-e2e-entra-only-target',
      ['entra'],
    );
  }, 60_000);

  it('checks an Entra ID configured only on its canvas node on that config', async () => {
    canvasConfigs['entra-id'] = CANVAS_ENTRA;
    checkEntraHealth.mockResolvedValue(true);

    await expect(run('canvas-config')).resolves.toBe(
      `Dynamic onboarding complete for ${user.email}.`,
    );
    // Nothing left out: no target to put on the timeline
    expect(getIdentityByEmail).toHaveBeenCalledWith(
      user.email,
      TENANT,
      'onboarding-e2e-entra-canvas-config',
      [],
    );

    const workflowId = 'onboarding-e2e-entra-canvas-config';
    expect(checkEntraHealth).toHaveBeenCalledWith(CANVAS_ENTRA, TENANT, workflowId);
    expect(provisionUserToEntra).toHaveBeenCalledTimes(1);
    // The health check ran on the config provisioning got
    expect(provisionUserToEntra.mock.calls[0][2]).toEqual(checkEntraHealth.mock.calls[0][0]);
    expect(entriesFor('entra').map(([, , status]) => status)).toEqual(['SYNCING', 'SYNCED']);
  }, 60_000);

  /** The run failed at the health check, before anything was provisioned. */
  async function expectHealthCheckFailed(id: string) {
    const error = await run(id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const cause = (error as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe('HealthCheckFailed');
    expect(cause?.message).toBe('Critical: entra is unreachable.');
    expect(provisionUserToEntra).not.toHaveBeenCalled();
    expect(provisionUserToAd).not.toHaveBeenCalled();
    expect(setProvisioningStatus).not.toHaveBeenCalled();
  }

  it('still fails the run when a configured Entra ID is unhealthy', async () => {
    installedEntra = INSTALLED_ENTRA;
    checkEntraHealth.mockResolvedValue(false);

    await expectHealthCheckFailed('unhealthy');
    expect(checkEntraHealth).toHaveBeenCalledWith(
      undefined,
      TENANT,
      'onboarding-e2e-entra-unhealthy',
    );
  }, 60_000);

  it('still fails the run on an incomplete installed config, never calling it not configured', async () => {
    // The real health check: the installed config is used and rejected, ENTRA_* is not tried
    installedEntra = { tenantId: 'entra-t1', clientId: 'app-t1' };
    env = {
      ENTRA_TENANT_ID: 'entra-tenant-env',
      ENTRA_CLIENT_ID: 'app-env',
      ENTRA_CLIENT_SECRET: 'secret-env',
    };

    await expectHealthCheckFailed('incomplete');
  }, 60_000);

  it('replays a history recorded before the patch onboarding:entra-not-configured', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.ONBOARDING_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (ONBOARDING_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      // Entra ID and AD, both healthy: the pre-patch code checks Entra ID with config undefined
      installedEntra = INSTALLED_ENTRA;
      checkEntraHealth.mockResolvedValue(true);
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(onboardingWorkflow, {
          args: [{ tenantId: TENANT } as unknown as Parameters<typeof onboardingWorkflow>[0]],
          taskQueue: pre.taskQueue,
          workflowId: 'onboarding-e2e-pre-entra-not-configured',
        });
        await expect(handle.result()).resolves.toBe('Dynamic onboarding complete for all users.');
        expect(checkEntraHealth).toHaveBeenCalledWith(
          undefined,
          TENANT,
          'onboarding-e2e-pre-entra-not-configured',
        );
        expect(provisionUserToEntra).toHaveBeenCalledTimes(1);
        expect(provisionUserToAd).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
