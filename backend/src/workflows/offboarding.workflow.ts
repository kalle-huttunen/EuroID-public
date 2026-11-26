/**
 * Offboarding Workflow
 *
 * Removes a leaver's access everywhere they have an account and reports per system what
 * happened. Started by OffboardingService (DELETE /identity/:id, HR leavers).
 *
 * Flow:
 * 0. Linked admin accounts first (offboarding-linked-admins.ts): each live linked admin identity
 *    of the person (PAM) is offboarded by a child offboardingWorkflow, one after another. One that
 *    fails or leaves a target failed counts as failed; one whose offboarding already runs
 *    elsewhere is not waited for.
 * 1. Discovery: getOffboardingTargets(identityId) reads identity.provisioning (every entry not
 *    yet DEPROVISIONED: SYNCED, and SYNCING / ERROR / PENDING, which may hold a half-created
 *    account; with the account id from the identity's account record), not the Blueprint.
 *    Only an identity with no provisioning state at all (provisioned before tracking) is tried
 *    in Entra ID, and only when an Entra ID connector is configured. A rerun after every target
 *    is DEPROVISIONED removes nothing more.
 * 2. Deprovision each target (offboarding-deprovision.ts): deprovisioned / already-gone /
 *    not-applicable (targets that keep no account) / failed with the reason, after the
 *    activity's Temporal retries. Every target is attempted.
 * 3. Golden Record, always: soft-deleted when no target and no linked admin account failed,
 *    otherwise suspended (login disabled) and kept so the remaining access stays visible and
 *    offboarding can be re-run. Right before the delete the person's linked admin identities are
 *    read again (checkNoLiveLinkedAdmins): one still live (its offboarding elsewhere has not
 *    finished, or it was linked meanwhile) counts as failed, so the person is suspended instead.
 * 4. The per-system result (with the linked admin accounts) goes to the identity timeline and
 *    the Leavers history (recordOffboardingOutcome). With a failure the workflow then fails
 *    (OffboardingPartialFailure, the result in the failure details); otherwise it returns it.
 *
 * Histories from before the patch offboarding:per-system-results replay the old flow
 * (legacyOffboarding): Entra fallback without a config check, Hub left untouched on failure.
 * Histories from before offboarding:unsynced-targets read SYNCED targets only
 * (getProvisionedTargets) and fall back to Entra whenever none is left. Histories from before
 * offboarding:linked-admin-cascade leave the linked admin accounts alone (step 0).
 */

import { proxyActivities, log, ApplicationFailure, workflowInfo } from '@temporalio/workflow';
import type { ConfigActivities } from '../activities/config.activities';
import type { EntraActivities } from '../activities/entra.activities';
import type { AdActivities } from '../activities/ad.activities';
import type { ScimActivities } from '../activities/scim.activities';
import type { IdentityActivities } from '../activities/identity.activities';
import type { EntraConfig } from '../modules/connectors/entra-connector/entra.interface';
import type { AdConfig } from '../modules/connectors/ad-connector/ad.interface';
import type { SCIMConnectorConfig } from '../modules/connectors/scim-connector/scim.interface';
import { normalizeSystemName, getSystemType } from '../shared/utils/normalize-system-name';
import { QUEUE_NAMES } from '../infrastructure/temporal/task-queue.config';
import { CONNECTOR_RETRY } from '../infrastructure/config/retry-policies';
import type { OffboardingActivities } from '../activities/offboarding.activities';
import type { OffboardingResult } from '../shared/types/deprovision';
import { isPatched } from './workflow-versioning';
import { deprovisionTarget, type DeprovisionTarget } from './offboarding-deprovision';
import {
  LINKED_ADMIN_CASCADE_PATCH,
  checkNoLiveLinkedAdmins,
  offboardLinkedAdmins,
} from './offboarding-linked-admins';

/** Per-system results, Entra fallback only when configured, Golden Record always updated. */
const PER_SYSTEM_RESULTS_PATCH = 'offboarding:per-system-results';

/**
 * Deprovision SYNCING, ERROR and PENDING entries too, and fall back to Entra only for an
 * identity with no provisioning state at all (not whenever no SYNCED target is left).
 */
const UNSYNCED_TARGETS_PATCH = 'offboarding:unsynced-targets';

const { getConnectorConfig } = proxyActivities<ConfigActivities>({ startToCloseTimeout: '10s' });
const {
  getProvisionedTargets,
  getOffboardingTargets,
  setProvisioningStatus,
  markDeleted,
  suspendIdentity,
} = proxyActivities<IdentityActivities>({
  startToCloseTimeout: '10s',
});
const { recordOffboardingOutcome } = proxyActivities<OffboardingActivities>({
  startToCloseTimeout: '10s',
});

const entraProxy = proxyActivities<Pick<EntraActivities, 'deleteUser'>>({
  taskQueue: QUEUE_NAMES['entra'],
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});
const adProxy = proxyActivities<Pick<AdActivities, 'disableAdUser'>>({
  taskQueue: QUEUE_NAMES['ad'],
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});
const scimProxy = proxyActivities<Pick<ScimActivities, 'deprovisionScimUser'>>({
  taskQueue: QUEUE_NAMES['scim'],
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});

/** Normalize targetSystem for getConnectorConfig lookup (entra -> entra-id) */
function normalizeTargetForConfig(system: string): string {
  if (getSystemType(system) === 'entra') return 'entra-id';
  if (getSystemType(system) === 'ad') return 'ad';
  if (normalizeSystemName(system) === 'scim') return 'scim';
  return system;
}

/** Get deprovision proxy for target system (routes to correct queue) */
function getDeprovisionProxy(
  system: string,
): typeof entraProxy | typeof adProxy | typeof scimProxy | null {
  if (getSystemType(system) === 'entra') return entraProxy;
  if (getSystemType(system) === 'ad') return adProxy;
  if (normalizeSystemName(system) === 'scim') return scimProxy;
  return null;
}

export interface OffboardingWorkflowInput {
  userId: string;
  userEmail: string;
  tenantId: string;
}

export async function offboardingWorkflow(
  input: OffboardingWorkflowInput | [string, string, string],
): Promise<OffboardingResult | string> {
  const [userId, userEmail, tenantId] = Array.isArray(input)
    ? [input[0], input[1], input[2] ?? '']
    : [input.userId, input.userEmail, input.tenantId ?? ''];

  if (!userId || !userEmail) {
    // Says which is missing, never the address itself (it is logged)
    const err = `Offboarding workflow requires userId and userEmail. Got userId=${userId || 'none'}, userEmail ${userEmail ? 'given' : 'none'}`;
    log.error(err);
    throw ApplicationFailure.nonRetryable(err, 'InvalidInput');
  }

  // Log lines name the person by identity id: Temporal's logger is not redacted
  log.info(`Starting offboarding workflow for identity ${userId}, tenantId: ${tenantId}`);

  if (!isPatched(PER_SYSTEM_RESULTS_PATCH)) {
    return legacyOffboarding(userId, userEmail, tenantId);
  }

  const ctx = { userId, userEmail, tenantId, workflowId: workflowInfo().workflowId };
  // Privileged accounts first: the person's linked admin identities, each offboarded in turn
  const cascade = isPatched(LINKED_ADMIN_CASCADE_PATCH);
  let linkedAdmins = cascade ? await offboardLinkedAdmins(ctx) : [];
  let targets: DeprovisionTarget[];
  let noProvisioningState: boolean;
  if (isPatched(UNSYNCED_TARGETS_PATCH)) {
    const found = await getOffboardingTargets(userId, tenantId);
    targets = found.targets;
    noProvisioningState = found.noProvisioningState;
  } else {
    targets = await getProvisionedTargets(userId, tenantId);
    noProvisioningState = targets.length === 0;
  }
  // No provisioning state (provisioned before tracking): Entra ID, and only when configured
  let entraConfig: Record<string, unknown> | undefined;
  if (noProvisioningState) {
    entraConfig = (await getConnectorConfig('entra-id', tenantId, ctx.workflowId)) ?? undefined;
    if (entraConfig) targets.push({ targetSystem: 'entra-id' });
    else log.info(`No provisioning state and no Entra ID connector: no account to remove`);
  }

  const systems: OffboardingResult['systems'] = [];
  for (const target of targets) {
    const result = await deprovisionTarget(target, ctx, entraConfig);
    systems.push(result);
    if (result.outcome === 'deprovisioned' || result.outcome === 'already-gone') {
      await setProvisioningStatus(
        userId,
        target.targetSystem,
        'DEPROVISIONED',
        undefined,
        tenantId,
      );
    }
  }

  const failedSystems = systems.filter((s) => s.outcome === 'failed');
  let failedAdmins = linkedAdmins.filter((a) => a.outcome === 'failed');
  if (cascade && failedSystems.length === 0 && failedAdmins.length === 0) {
    // About to delete the person: none of their admin identities may still be live
    linkedAdmins = await checkNoLiveLinkedAdmins(ctx, linkedAdmins);
    failedAdmins = linkedAdmins.filter((a) => a.outcome === 'failed');
  }
  const incomplete = failedSystems.length > 0 || failedAdmins.length > 0;
  const result: OffboardingResult = {
    identityId: userId,
    workflowId: ctx.workflowId,
    status: incomplete ? 'partial-failure' : 'completed',
    hubStatus: incomplete ? 'suspended' : 'deleted',
    systems,
    ...(linkedAdmins.length ? { linkedAdmins } : {}),
  };
  // Avoid permanent orphans: a failed target or admin account keeps the Golden Record, suspended
  if (incomplete) await suspendIdentity(userId, tenantId);
  else await markDeleted(userId, tenantId);
  await recordOffboardingOutcome(result, tenantId);

  if (incomplete) {
    const counts = [
      ...(failedSystems.length ? [`${failedSystems.length} target(s)`] : []),
      ...(failedAdmins.length ? [`${failedAdmins.length} linked admin account(s)`] : []),
    ];
    const failures = [
      ...failedSystems.map((s) => `${s.system}: ${s.reason ?? 'unknown'}`),
      ...failedAdmins.map((a) => `linked admin identity ${a.identityId}: ${a.reason ?? 'unknown'}`),
    ];
    throw ApplicationFailure.create({
      type: 'OffboardingPartialFailure',
      nonRetryable: true,
      message:
        `Offboarding partial failure for ${userId}: ${counts.join(' and ')} failed ` +
        `(${failures.join('; ')}). Golden Record suspended, not deleted.`,
      details: [result],
    });
  }
  log.info(
    `Offboarding complete for ${userId}: ${systems.length} target(s), Golden Record deleted`,
  );
  return result;
}

/** The flow before PER_SYSTEM_RESULTS_PATCH, kept for replaying its histories. */
async function legacyOffboarding(
  userId: string,
  userEmail: string,
  tenantId: string,
): Promise<string> {
  // 1. Discover where the user actually exists (from identity.provisioning)
  let provisionedTargets = await getProvisionedTargets(userId, tenantId);

  // Legacy fallback: if no provisioning state (pre-tracking users), try Entra ID
  if (provisionedTargets.length === 0) {
    log.info(
      `No provisioning state for identity ${userId}: attempting legacy Entra ID deprovision`,
    );
    provisionedTargets = [{ targetSystem: 'entra-id', externalId: undefined }];
  }

  log.info(`Deprovisioning from ${provisionedTargets.length} target(s) for identity ${userId}`);

  const results: { system: string; success: boolean; error?: string }[] = [];

  for (const { targetSystem, externalId } of provisionedTargets) {
    const configKey = normalizeTargetForConfig(targetSystem);
    const config = await getConnectorConfig(configKey, tenantId);

    if (!config) {
      log.warn(
        `Connector config not found for ${targetSystem} (may be removed from Blueprint) — skipping`,
      );
      results.push({ system: targetSystem, success: false, error: 'Config not found' });
      continue;
    }

    const proxy = getDeprovisionProxy(targetSystem);
    if (!proxy) {
      log.warn(`Unknown connector type for ${targetSystem} — skipping`);
      results.push({ system: targetSystem, success: false, error: 'Unknown connector' });
      continue;
    }

    try {
      const s = normalizeSystemName(targetSystem);
      let success = false;

      if (getSystemType(targetSystem) === 'entra') {
        await entraProxy.deleteUser(userEmail, config as unknown as EntraConfig, userId, tenantId);
        success = true;
        log.info(`Deprovisioned identity ${userId} from ${targetSystem}`);
      } else if (getSystemType(targetSystem) === 'ad') {
        const identifier = externalId ?? userEmail;
        if (!externalId) {
          log.warn(`No externalId for AD target ${targetSystem} — cannot deprovision without DN`);
          results.push({ system: targetSystem, success: false, error: 'Missing externalId' });
          continue;
        }
        success = await adProxy.disableAdUser(identifier, config as unknown as AdConfig, tenantId);
        if (success) {
          log.info(`Deprovisioned from ${targetSystem}`);
        } else {
          log.warn(`Failed to deprovision from ${targetSystem}`);
        }
      } else if (s === 'scim') {
        if (!externalId) {
          log.warn(`No externalId for SCIM target ${targetSystem} — cannot deprovision`);
          results.push({ system: targetSystem, success: false, error: 'Missing externalId' });
          continue;
        }
        await scimProxy.deprovisionScimUser(
          config as unknown as SCIMConnectorConfig,
          externalId,
          tenantId,
        );
        success = true;
        log.info(`Deprovisioned from ${targetSystem}`);
      }

      if (success) {
        await setProvisioningStatus(userId, targetSystem, 'DEPROVISIONED', undefined, tenantId);
      }
      results.push({ system: targetSystem, success });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Deprovision failed for ${targetSystem}: ${msg}`);
      results.push({ system: targetSystem, success: false, error: msg });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  // Only mark Hub deleted when all deprovisions succeeded (avoid permanent orphans)
  if (failCount > 0) {
    const failedSystems = results
      .filter((r) => !r.success)
      .map((r) => `${r.system}: ${r.error ?? 'unknown'}`);
    // By identity id: failure messages stay in clear in the history (no payload, no codec)
    throw ApplicationFailure.nonRetryable(
      `Offboarding partial failure for identity ${userId}: ${failCount} target(s) failed. ` +
        `Failed: ${failedSystems.join('; ')}. Hub not marked deleted.`,
      'OffboardingPartialFailure',
    );
  }

  log.info(`Marking user ${userId} as deleted in Hub`);
  await markDeleted(userId, tenantId);

  log.info(
    `Offboarding workflow completed for identity ${userId}. Deprovisioned: ${successCount} system(s).`,
  );

  return `Offboarding complete for ${userEmail}. Deprovisioned from ${successCount} system(s).`;
}
