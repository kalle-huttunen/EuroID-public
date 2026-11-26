/**
 * Onboarding (and admin account provisioning) calls a target without a task queue of its own as
 * check<System>Health / provisionUserTo<System> on the default queue, <System> being the canvas
 * system name (the connector id) with its first letter capitalised. If the default-queue worker
 * registers no activity under exactly that name, every joiner to the target fails at the health
 * check (an unregistered activity type).
 */
import { buildDefaultActivities, defaultQueueTargetActivities } from './worker-default-activities';
import { registerBuiltInConnectors } from './modules/connectors/plugin/register-connectors';
import type { PluginRegistryService } from './modules/connectors/plugin/plugin-registry.service';
import type { ConnectorManifest } from './modules/connectors/plugin/connector-manifest.interface';
import { EntraActivities } from './activities/entra.activities';
import { AdActivities } from './activities/ad.activities';
import { ScimActivities } from './activities/scim.activities';
import { OktaActivities } from './activities/okta.activities';

/**
 * The names onboarding builds (getHealthMethodName in onboarding-health-check.ts,
 * getProvisionMethodName in onboarding.workflow.ts).
 */
const cap = (system: string) => system.charAt(0).toUpperCase() + system.slice(1);
const healthName = (system: string) => `check${cap(system)}Health`;
const provisionName = (system: string) => `provisionUserTo${cap(system)}`;

/** Activity instances whose every method is a stub, recording the method it stands for. */
function stubActivities<T>(): T {
  return new Proxy(
    {},
    {
      get: (_target, group: string) =>
        new Proxy(
          {},
          {
            get: (_t, method: string) => {
              const fn = () => `${group}.${method}`;
              return fn;
            },
          },
        ),
    },
  ) as T;
}

const manifests: ConnectorManifest[] = [];
registerBuiltInConnectors({
  register: (manifest: ConnectorManifest) => manifests.push(manifest),
} as unknown as PluginRegistryService);
/** Provisioning targets that worker.ts gives no queue of their own. */
const defaultQueueTargets = manifests
  .filter((m) => m.capabilities.includes('provision') && !m.taskQueue)
  .map((m) => m.id);

describe('default queue target activities', () => {
  it('covers exactly the provisioning targets without a task queue', () => {
    expect(defaultQueueTargets.sort()).toEqual(
      ['discord-webhook', 'file-outbound', 'github', 'google-sheets', 'servicenow'].sort(),
    );
  });

  it.each(defaultQueueTargets)(
    'registers the health check and provision onboarding schedules for %s',
    (system) => {
      const activities = buildDefaultActivities(stubActivities());
      expect(typeof activities[healthName(system)]).toBe('function');
      expect(typeof activities[provisionName(system)]).toBe('function');
    },
  );

  it("binds each name to the connector's own activity", () => {
    const activities = defaultQueueTargetActivities(stubActivities()) as Record<
      string,
      () => string
    >;
    expect(Object.fromEntries(Object.entries(activities).map(([k, fn]) => [k, fn()]))).toEqual({
      checkGithubHealth: 'github.checkGitHubHealth',
      provisionUserToGithub: 'github.provisionUserToGitHub',
      checkServicenowHealth: 'serviceNow.checkServiceNowHealth',
      provisionUserToServicenow: 'serviceNow.provisionUserToServiceNow',
      'checkDiscord-webhookHealth': 'noAccountTargets.checkDiscordWebhookHealth',
      'provisionUserToDiscord-webhook': 'noAccountTargets.provisionUserToDiscordWebhook',
      'checkGoogle-sheetsHealth': 'noAccountTargets.checkGoogleSheetsHealth',
      'provisionUserToGoogle-sheets': 'noAccountTargets.provisionUserToGoogleSheets',
      'checkFile-outboundHealth': 'noAccountTargets.checkFileOutboundHealth',
      'provisionUserToFile-outbound': 'noAccountTargets.provisionUserToFileOutbound',
    });
  });
});

describe('mover workflow activities on the default queue', () => {
  it('registers what the mover schedules there, and leaves applyMoverAccess to the connector queues', () => {
    const activities = buildDefaultActivities(stubActivities());
    for (const name of [
      // patch mover:identity-by-id
      'getPipelineStatus',
      'evaluateMoverChange',
      'getActiveTargetSystems',
      'setProvisioningStatus',
      'recordMoverOutcome',
      // histories from before it
      'getIdentityByEmail',
      'evaluateUser',
      'computeEntitlementDelta',
      'getConnectorConfig',
    ]) {
      expect(typeof activities[name]).toBe('function');
    }
    expect(activities.applyMoverAccess).toBeUndefined();
  });
});

describe('credential rotation workflow activities on the default queue', () => {
  it('binds the tenant listing (patch credential-rotation:per-tenant) and the per-tenant run', () => {
    const activities = buildDefaultActivities(stubActivities()) as Record<string, () => string>;
    expect(activities.listCredentialRotationTenants()).toBe(
      'credentialRotation.listCredentialRotationTenants',
    );
    expect(activities.runCredentialRotationBatch()).toBe(
      'credentialRotation.runCredentialRotationBatch',
    );
  });
});

describe('offboarding workflow activities on the default queue', () => {
  it('binds the linked admin lookup of patch offboarding:linked-admin-cascade', () => {
    const activities = buildDefaultActivities(stubActivities()) as Record<string, () => string>;
    expect(activities.getLinkedAdminIdentities()).toBe('privilegedAccess.getLinkedAdminIdentities');
  });
});

describe('Entra ID queue activities (connector manifest, registered by worker.ts)', () => {
  const entra = manifests.find((m) => m.taskQueue === 'provisioning-entra');

  it.each(['isEntraConfigured', 'checkEntraHealth', 'provisionUserToEntra'])(
    'registers %s, which onboarding schedules on the Entra ID queue, as an EntraActivities method',
    (name) => {
      const method = entra?.activityBindings?.[name] ?? '';
      expect(entra?.activityClass).toBe(EntraActivities);
      expect(typeof (EntraActivities.prototype as unknown as Record<string, unknown>)[method]).toBe(
        'function',
      );
    },
  );
});

describe('privileged session activities on the connector queues', () => {
  it.each([
    ['provisioning-entra', 'enableEntraUser', EntraActivities],
    ['provisioning-entra', 'disableEntraUser', EntraActivities],
    ['provisioning-ad', 'setAdUserEnabled', AdActivities],
    ['provisioning-scim', 'setScimUserActive', ScimActivities],
    ['provisioning-okta', 'setOktaUserEnabled', OktaActivities],
  ] as const)(
    '%s registers %s, which privilegedSessionWorkflow schedules there',
    (queue, name, cls) => {
      const manifest = manifests.find((m) => m.taskQueue === queue);
      const method = manifest?.activityBindings?.[name] ?? '';
      expect(manifest?.activityClass).toBe(cls);
      expect(typeof (cls.prototype as unknown as Record<string, unknown>)[method]).toBe('function');
    },
  );
});

// archivalWorkflow's first activity was not registered on the default queue, so every scheduled
// archival run (ARCHIVAL_ENABLED=true) failed at once on an unregistered activity type.
describe('archival activities', () => {
  it('registers every activity the archival workflow calls, before and after its patch', () => {
    const activities = buildDefaultActivities(stubActivities()) as Record<string, () => string>;
    const names = [
      'listArchivalTenantIds',
      'findDocumentsForArchival',
      'computeDateRange',
      'exportBatchToStorage',
      'findArchivalBatch',
      'exportArchivalBatch',
      'deleteArchivedBatch',
      'recordArchivalMetadata',
    ];
    expect(Object.fromEntries(names.map((name) => [name, activities[name]?.()]))).toEqual(
      Object.fromEntries(names.map((name) => [name, `archival.${name}`])),
    );
  });
});
