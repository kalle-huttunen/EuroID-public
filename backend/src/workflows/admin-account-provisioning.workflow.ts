/**
 * Admin Account Provisioning Workflow
 *
 * Creates linked admin identity and provisions privileged entitlements to target systems.
 * Triggered by onboarding workflow when adminOperations exist in policy intent.
 *
 * Flow:
 * 1. getOrCreateLinkedAdminIdentity (idempotent)
 * 2. Provision admin to each target system (Entra, AD, etc.) with adminOperations; the
 *    connectors create the accounts disabled (linked-admin-profile.ts)
 * 3. Ask for a disable-only privileged session run (settleAdminAccountState), unless nothing
 *    was provisioned
 *
 * Bulkhead: Entra, AD, Okta and SCIM activities run on their own task queues (Okta and SCIM
 * through onboarding-queued-connectors.ts, like onboarding).
 */

import { proxyActivities, log, workflowInfo } from '@temporalio/workflow';
import type { PrivilegedAccessActivities } from '../activities/privileged-access.activities';
import type { ConfigActivities } from '../activities/config.activities';
import type { IdentityActivities } from '../activities/identity.activities';
import type { EntraActivities } from '../activities/entra.activities';
import type { AdActivities } from '../activities/ad.activities';
import type { WritebackActivities } from '../activities/writeback.activities';
import type { PipelineActivities } from '../activities/pipeline.activities';
import type { EntraConfig } from '../modules/connectors/entra-connector/entra.interface';
import type { AdConfig } from '../modules/connectors/ad-connector/ad.interface';
/** Admin operation from policy engine (privileged entitlement) */
interface AdminOperation {
  type: string;
  action: string;
  target: string;
  targetId: string;
  sourcePolicy: string;
  adminTier: 'TIER_0' | 'TIER_1' | 'TIER_2';
  params?: Record<string, unknown>;
  timeConstraint?: { durationDays?: number; expiresAt?: Date };
}
import { getSystemType } from '../shared/utils/normalize-system-name';
import { QUEUE_NAMES } from '../infrastructure/temporal/task-queue.config';
import { CONNECTOR_RETRY, QUERY_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';
import { isQueuedConnector, provisionToQueuedConnector } from './onboarding-queued-connectors';
import { createdEntraAccount } from './entra-created-account';
import { reasonOf } from './mover-access';
import { unprovisionedReason } from './provision-result';

/**
 * Okta and SCIM activities are registered only on their plugin queues (worker.ts), so they are
 * called there, SCIM with its (config, user, tenantId, correlationId) signature and the canvas
 * config. Histories from before this patch scheduled them on the default queue.
 */
const CONNECTOR_QUEUE_PATCH = 'admin-account-provisioning:connector-queue-routing';

/**
 * Entra ID provisioning that created the admin account but did not make a group, directory role
 * or license change fails (EntraChangesFailed) with the account in its details: the account is
 * written back before the target is marked ERROR, so the next run updates it instead of
 * creating a second one. Histories from before this patch mark the target ERROR only.
 */
const ENTRA_CREATED_WRITEBACK_PATCH = 'admin-account-provisioning:entra-created-account-writeback';

/**
 * A linked admin account stands disabled outside a privileged session; the connector mappers
 * create it so (shared/utils/linked-admin-profile.ts). Provisioning can still leave one enabled
 * (an account it updated with a session state that changed since the profile was read, an AD
 * account it found existing), so a run that provisioned a target asks for a disable-only
 * session run (settleAdminAccountState: started unless a session is open). Histories from
 * before this patch end after the last target.
 */
const SETTLE_STANDING_STATE_PATCH = 'admin-account-provisioning:settle-standing-state';

/**
 * Entra ID with no config anywhere (isEntraConfigured: the canvas node's config, else the
 * tenant's installed connector config, else ENTRA_*) is left out of the run, as onboarding
 * leaves it out of the person's own run: the admin account is not provisioned there and the run
 * goes on. Histories from before this patch called provisionUserToEntra, which failed the run
 * and with it the person's onboarding.
 */
const ENTRA_NOT_CONFIGURED_PATCH = 'admin-account-provisioning:entra-not-configured';

/**
 * A provision that answers `success: false` (provisionUserToAd for an AD node without a canvas
 * config: the child has no health check) leaves the target ERROR with the target's reason, counts
 * nothing for the circuit breaker and is not settled, since no account was made. Histories from
 * before this patch marked it SYNCED and counted a success.
 */
const UNPROVISIONED_PATCH = 'admin-account-provisioning:unprovisioned-not-synced';

/** Typed interface for dynamic connector activity invocation */
interface GenericConnectorActivities {
  [key: string]: (...args: unknown[]) => Promise<unknown>;
}

const { getOrCreateLinkedAdminIdentity } = proxyActivities<PrivilegedAccessActivities>({
  startToCloseTimeout: '30s',
  retry: QUERY_RETRY,
});

// Retried until it answers: the account's standing state must not be left to chance
const { settleAdminAccountState } = proxyActivities<PrivilegedAccessActivities>({
  startToCloseTimeout: '30s',
});

const { getActiveTargetSystems, getConnectorConfig } = proxyActivities<ConfigActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});

const { setProvisioningStatus } = proxyActivities<IdentityActivities>({
  startToCloseTimeout: '10s',
});

const { writebackToIdentity } = proxyActivities<WritebackActivities>({
  startToCloseTimeout: '15s',
});

const { recordProvisioningOutcome } = proxyActivities<PipelineActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});

const entraProxy = proxyActivities<EntraActivities>({
  taskQueue: QUEUE_NAMES['entra'],
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});

const adProxy = proxyActivities<AdActivities>({
  taskQueue: QUEUE_NAMES['ad'],
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});

const defaultConnectorProxy = proxyActivities<GenericConnectorActivities>({
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});

function getProvisionProxy(system: string) {
  if (getSystemType(system) === 'entra') return entraProxy;
  if (getSystemType(system) === 'ad') return adProxy;
  return defaultConnectorProxy;
}

function getProvisionMethodName(system: string) {
  const cap = (x: string) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : '');
  if (getSystemType(system) === 'entra') return 'provisionUserToEntra';
  if (getSystemType(system) === 'ad') return 'provisionUserToAd';
  return `provisionUserTo${cap(system)}`;
}

function normalizeTargetSystemForWriteback(system: string): string {
  if (getSystemType(system) === 'entra') return 'entra-id';
  if (getSystemType(system) === 'ad') return 'ad';
  return system;
}

export interface AdminAccountProvisioningInput {
  parentIdentityId: string;
  adminTier: string;
  adminOperations: AdminOperation[];
  tenantId: string;
}

export async function adminAccountProvisioningWorkflow(
  input: AdminAccountProvisioningInput,
): Promise<string> {
  const { parentIdentityId, adminTier, adminOperations, tenantId } = input;

  log.info(`[PAM] Starting admin provisioning for parent ${parentIdentityId}, tier ${adminTier}`);

  const { adminIdentityId, adminProfile } = await getOrCreateLinkedAdminIdentity(
    parentIdentityId,
    adminTier,
    tenantId,
  );

  const operations = adminOperations.map(({ adminTier: _t, ...op }) => op);
  const targetSystems = await getActiveTargetSystems(tenantId);

  let provisioned = 0;
  for (const system of targetSystems.filter(Boolean)) {
    let systemOps: Array<{ type: string; action: string; targetId: string }>;
    if (getSystemType(system) === 'entra') {
      systemOps = operations.filter(
        (op) =>
          (op.target === 'entra' || op.target === 'entra-id' || op.target === 'all') &&
          (op.type === 'group' || op.type === 'license' || op.type === 'role'),
      ) as Array<{ type: string; action: string; targetId: string }>;
    } else if (getSystemType(system) === 'ad') {
      systemOps = operations.filter(
        (op) =>
          (op.target === 'ad' || op.target === 'active-directory' || op.target === 'all') &&
          (op.type === 'group' || op.type === 'license' || op.type === 'role'),
      ) as Array<{ type: string; action: string; targetId: string }>;
    } else {
      systemOps = operations.filter(
        (op) => op.target === system || op.target === `${system}-id` || op.target === 'all',
      ) as Array<{ type: string; action: string; targetId: string }>;
    }

    if (systemOps.length === 0) continue;

    if (getSystemType(system) === 'entra' && isPatched(ENTRA_NOT_CONFIGURED_PATCH)) {
      const canvasConfig = await getConnectorConfig('entra-id', tenantId);
      const configured = await entraProxy.isEntraConfigured(
        (canvasConfig as unknown as EntraConfig | null) ?? undefined,
        tenantId,
        workflowInfo().workflowId,
      );
      if (!configured) {
        log.warn(
          `[PAM] Entra ID is not configured: admin identity ${adminIdentityId} is not ` +
            'provisioned there in this run',
        );
        continue;
      }
    }

    await setProvisioningStatus(adminIdentityId, system, 'SYNCING', undefined, tenantId);

    try {
      const provisionProxy = getProvisionProxy(system);
      const methodName = getProvisionMethodName(system);
      let provisionResult:
        | {
            success?: boolean;
            error?: unknown;
            objectId?: string;
            generatedAttributes?: Record<string, unknown>;
          }
        | undefined;

      if (getSystemType(system) === 'entra') {
        const entraConfig = await getConnectorConfig('entra-id', tenantId);
        provisionResult = await entraProxy.provisionUserToEntra(
          adminProfile,
          {
            operations: systemOps as Array<{
              type: 'group' | 'license' | 'role';
              action: 'add' | 'remove';
              targetId: string;
            }>,
          },
          (entraConfig as unknown as EntraConfig) ?? undefined,
          tenantId,
        );
      } else if (getSystemType(system) === 'ad') {
        const adConfig = await getConnectorConfig('ad', tenantId);
        provisionResult = await adProxy.provisionUserToAd(
          adminProfile,
          {
            operations: systemOps as Array<{
              type: 'group' | 'license' | 'role';
              action: 'add' | 'remove';
              targetId: string;
            }>,
          },
          (adConfig as unknown as AdConfig) ?? undefined,
          tenantId,
        );
      } else if (isQueuedConnector(system) && isPatched(CONNECTOR_QUEUE_PATCH)) {
        provisionResult = await provisionToQueuedConnector(
          system,
          adminProfile,
          systemOps,
          tenantId,
          workflowInfo().workflowId,
        );
      } else {
        // (user, intent, config, tenantId), like provisionUserToEntra/Ad/Okta
        provisionResult = (await (provisionProxy as GenericConnectorActivities)[methodName](
          adminProfile,
          { operations: systemOps },
          undefined,
          tenantId,
        )) as typeof provisionResult;
      }

      const unprovisioned = unprovisionedReason(provisionResult);
      if (unprovisioned !== undefined && isPatched(UNPROVISIONED_PATCH)) {
        log.warn(
          `[PAM] ${system} did not provision admin identity ${adminIdentityId}: ${unprovisioned}`,
        );
        await setProvisioningStatus(adminIdentityId, system, 'ERROR', unprovisioned, tenantId);
        continue;
      }

      const hasWritebackPayload =
        provisionResult?.objectId != null ||
        provisionResult?.generatedAttributes?.['distinguishedName'] != null;
      if (provisionResult?.success && hasWritebackPayload) {
        const writebackSystem = normalizeTargetSystemForWriteback(system);
        await writebackToIdentity(adminIdentityId, writebackSystem, provisionResult, tenantId);
      }
      await setProvisioningStatus(adminIdentityId, system, 'SYNCED', undefined, tenantId);
      await recordProvisioningOutcome(tenantId, true);
      provisioned++;
    } catch (err: unknown) {
      // The activity's own reason (an argument's value: the command sequence is unchanged)
      const message = reasonOf(err);
      log.error(
        `[PAM] Provisioning admin identity ${adminIdentityId} to ${system} failed: ${message}`,
      );
      const created = createdEntraAccount(err);
      if (created && isPatched(ENTRA_CREATED_WRITEBACK_PATCH)) {
        try {
          const writebackSystem = normalizeTargetSystemForWriteback(system);
          await writebackToIdentity(adminIdentityId, writebackSystem, created, tenantId);
        } catch (writebackErr: unknown) {
          const reason = writebackErr instanceof Error ? writebackErr.message : writebackErr;
          log.error(`[PAM] Writeback of the account ${system} created failed: ${reason}`);
        }
      }
      await setProvisioningStatus(adminIdentityId, system, 'ERROR', message, tenantId);
      await recordProvisioningOutcome(tenantId, false);
      throw err;
    }
  }

  if (provisioned > 0 && isPatched(SETTLE_STANDING_STATE_PATCH)) {
    await settleAdminAccountState(adminIdentityId, tenantId, workflowInfo().workflowId);
  }

  // By id, never the UPN: Temporal's runtime logger is not redacted
  log.info(`[PAM] Admin provisioning complete for admin identity ${adminIdentityId}`);
  return `Admin account ${adminProfile.email} provisioned.`;
}
