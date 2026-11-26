/**
 * Dynamic Onboarding Workflow
 *
 * This workflow is completely system-agnostic. It doesn't hardcode which target systems
 * (AD, Azure, Google Workspace, etc.) to provision users to. Instead, it queries the
 * Config Activity at runtime to discover which systems are currently active on the canvas.
 *
 * Flow:
 * 1. Discovery: Asks "What systems are connected?" via getActiveTargetSystems()
 * 2. Technical Handshake: Validates connectivity to each discovered system
 * 3. Provision: Fetches new hires from HR and dynamically provisions them to all active systems
 *
 * Bulkhead: Connector-specific activities (provisionUserToEntra, checkAdHealth, etc.) are
 * routed to per-connector task queues (provisioning-entra, provisioning-ad, provisioning-okta,
 * provisioning-scim) so a slow or failing connector cannot starve others.
 *
 * @see docs/architecture/IMPROVEMENT_PLAN.md §1.2
 * @see docs/tasks/CURRENT_TASK_20.md
 */

import {
  proxyActivities,
  defineQuery,
  setHandler,
  log,
  workflowInfo,
  ApplicationFailure,
} from '@temporalio/workflow';
import type { ConfigActivities } from '../activities/config.activities';
import type { HrActivities } from '../activities/hr.activities';
import type { IdentityActivities } from '../activities/identity.activities';
import type { PolicyActivities } from '../activities/policy.activities';
import type { EntraActivities } from '../activities/entra.activities';
import type { AdActivities } from '../activities/ad.activities';
import type { PipelineActivities } from '../activities/pipeline.activities';
import type { WritebackActivities } from '../activities/writeback.activities';
import type { StandardUserDto } from '../shared/dtos/standard-user.dto';
import type { EntraConfig } from '../modules/connectors/entra-connector/entra.interface';
import type { AdConfig } from '../modules/connectors/ad-connector/ad.interface';
import {
  evaluateEdgeConditions,
  type EdgeFlowData,
} from '../modules/blueprints/edge-condition-evaluator';
import { normalizeSystemName, getSystemType } from '../shared/utils/normalize-system-name';
import { QUEUE_NAMES } from '../infrastructure/temporal/task-queue.config';
import { CONNECTOR_RETRY, QUERY_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';
import { isQueuedConnector, provisionToQueuedConnector } from './onboarding-queued-connectors';
import {
  CONNECTOR_QUEUE_PATCH,
  checkTargetHealth,
  withSkippedTargets,
} from './onboarding-health-check';
import { workflowNow } from './workflow-time';
import { createdEntraAccount } from './entra-created-account';
import { reasonOf } from './mover-access';
import {
  recordSodBlock,
  sodBlockFailure,
  sodBlockReason,
  type SodBlockedPerson,
} from './onboarding-sod-block';
import { reviewExcludedTargets, withReviewExcludedTargets } from './onboarding-review-exclusions';
import {
  adminAccountsFailure,
  provisionAdminAccounts,
  type AdminAccountsFailed,
} from './onboarding-admin-tiers';
import {
  failWithoutTarget,
  onboardingInputOf,
  type OnboardingWorkflowInput,
} from './onboarding-input';
import { policyTimeConstraint, targetOperations } from './onboarding-target-operations';
import { unprovisionedReason, withNotProvisioned } from './provision-result';
import {
  legacyPipelineBlockReason,
  pipelineBlockReason,
  withPipelineSkips,
} from './pipeline-guard';

/**
 * The admin-account-provisioning child carries this workflow's TenantId search attribute and
 * memo, so tenant-checked reads find it. Histories from before this patch started it without.
 */
const CHILD_TENANT_PATCH = 'onboarding:child-tenant-attributes';

/**
 * The target's generated attributes and account id (Entra objectId, AD DN, Okta and SCIM ids)
 * are written back until a writeback has completed for that target (writebackComplete). Before
 * this patch only a PENDING entry was written back, which no code creates, so the account id
 * never reached the identity and offboarding could not find the account.
 */
const WRITEBACK_UNTIL_COMPLETE_PATCH = 'onboarding:writeback-until-complete';

/**
 * A target already SYNCED with its writeback complete is not provisioned again, so a second run
 * for the person posts no second Discord message, file line, sheet row or ServiceNow incident. A
 * provision with nothing to write back completes the writeback at once. Histories from before
 * this patch provisioned every target on every run.
 */
const SKIP_SYNCED_PATCH = 'onboarding:skip-synced-targets';

/**
 * Entra ID provisioning that created the account but did not make a group, directory role or
 * license change fails (EntraChangesFailed) with the account in its details: the account is
 * written back before the target is marked ERROR, so the next run updates it instead of
 * creating a second one. Histories from before this patch mark the target ERROR only.
 */
const ENTRA_CREATED_WRITEBACK_PATCH = 'onboarding:entra-created-account-writeback';

/**
 * A provision that answers `success: false` (provisionUserToAd without a host or base DN) leaves
 * the target ERROR with the target's reason, counts nothing for the circuit breaker and is named
 * in the result; a write-back that answers `success: false` (the identity is gone) leaves the
 * writeback incomplete, so the next run writes the account id back again. Histories from before
 * this patch marked both SYNCED, the writeback complete and the provision a success.
 */
const UNPROVISIONED_PATCH = 'onboarding:unprovisioned-not-synced';

/**
 * The pipeline guard runs before the person's admin accounts and lets only a DEPLOYED pipeline
 * provision (pipeline-guard.ts); the result counts the people it left out and says why. Histories
 * from before this patch ran the admin account children first and skipped the person only while
 * the pipeline was PAUSED or STOPPED, so a paused pipeline still made privileged admin accounts
 * and a DRAFT or SIMULATED one provisioned everything.
 */
const PIPELINE_GUARD_PATCH = 'onboarding:pipeline-guard-deployed';

/** Typed interface for dynamic connector activity invocation (unknown connectors) */
interface GenericConnectorActivities {
  [key: string]: (...args: unknown[]) => Promise<unknown>;
}

// Default queue — config, identity, policy, hr, writeback (generic activities)
const { getActiveTargetSystems, getConnectorConfig, getEdgeConditions } =
  proxyActivities<ConfigActivities>({ startToCloseTimeout: '10s', retry: QUERY_RETRY });
const { getPipelineStatus, recordProvisioningOutcome } = proxyActivities<PipelineActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});
const { fetchNewHires } = proxyActivities<HrActivities>({ startToCloseTimeout: '1 minute' });
const { saveToHub, getUserByEmail, getIdentityByEmail, setProvisioningStatus } =
  proxyActivities<IdentityActivities>({ startToCloseTimeout: '10 seconds' });
const { evaluateUser } = proxyActivities<PolicyActivities>({ startToCloseTimeout: '30 seconds' });
const { writebackToIdentity, writebackToHrSource } = proxyActivities<WritebackActivities>({
  startToCloseTimeout: '15 seconds',
});

// Connector-specific queues — bulkhead isolation
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
// Connectors without a queue of their own (GitHub, ServiceNow, Discord webhook, Google Sheets,
// File outbound) and unknown ones: the default queue, as check<System>Health /
// provisionUserTo<System> (registered in worker-default-activities.ts)
const defaultConnectorProxy = proxyActivities<GenericConnectorActivities>({
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});

/** Get connector proxy for provisioning (routes to correct queue) */
function getProvisionProxy(system: string) {
  if (getSystemType(system) === 'entra') return entraProxy;
  if (getSystemType(system) === 'ad') return adProxy;
  return defaultConnectorProxy;
}

/** Normalize system name for writeback source (entra-id, ad) */
function normalizeTargetSystemForWriteback(system: string): string {
  if (getSystemType(system) === 'entra') return 'entra-id';
  if (getSystemType(system) === 'ad') return 'ad';
  return system;
}

/** Get provision method name for system (e.g., 'entra' -> 'provisionUserToEntra') */
function getProvisionMethodName(system: string) {
  const cap = (x: string) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : '');
  if (getSystemType(system) === 'entra') return 'provisionUserToEntra';
  if (getSystemType(system) === 'ad') return 'provisionUserToAd';
  return `provisionUserTo${cap(system)}`;
}

// Edge condition evaluator: imported from modules/blueprints/edge-condition-evaluator.ts
// (pure TypeScript module with zero NestJS deps — safe for Temporal workflows)

// Define the Query - allows frontend to ask "Where are you in the journey?"
export const getCurrentStepQuery = defineQuery<string>('getCurrentStep');

export type { OnboardingWorkflowInput } from './onboarding-input';

export async function onboardingWorkflow(
  input: OnboardingWorkflowInput | string,
  tenantIdArg?: string,
): Promise<string> {
  // Supports the legacy (targetEmail, tenantId) and the input object call signatures
  const { targetEmail, tenantId, syncToEntra } = onboardingInputOf(input, tenantIdArg);
  failWithoutTarget(targetEmail);

  const correlationId = workflowInfo().workflowId;

  // Track the current step for the progress dashboard
  let currentStep = 'INITIALIZING';

  // Set the handler so the API can query the workflow's current state
  setHandler(getCurrentStepQuery, () => currentStep);

  // Log what we received: never the address (Temporal's logger is not redacted); the workflow id
  // names the identity of a one-person run
  log.info(
    `Workflow started for ${targetEmail ? 'one person' : 'all users'}, tenantId: ${tenantId}`,
  );
  log.info(`targetEmail type: ${typeof targetEmail}, truthy: ${!!targetEmail}`);

  // 1. Ask the Brain: "What systems are currently connected on the canvas?"
  currentStep = 'DISCOVERING_SYSTEMS';
  const targetSystems = await getActiveTargetSystems(tenantId, correlationId);

  // 2. Technical Handshake: Check health for all discovered systems in parallel. Targets left
  // out of this run because nothing is configured for them (Entra ID, AD) are not provisioned.
  currentStep = 'HEALTH_CHECK';
  const notConfigured = await checkTargetHealth(targetSystems, tenantId, correlationId);

  // 3. Fetch users to process
  currentStep = 'FETCH_USERS';
  let usersToProcess: StandardUserDto[];

  log.info(`Checking targetEmail: type=${typeof targetEmail}, truthiness=${!!targetEmail}`);

  if (targetEmail) {
    // Prefer Identity (Onion) when available for provisioning state tracking
    log.info(`[UPDATE PATH] Fetching the identity from Hub for update sync`);
    const identity = await getIdentityByEmail(targetEmail, tenantId, correlationId);
    const user = identity
      ? identity.profile
      : await getUserByEmail(targetEmail, tenantId, correlationId);

    if (!user) {
      // No address: failure messages stay in clear in the history (the payload codec covers
      // payloads only). Replay compares the failure command's type, not its message.
      throw ApplicationFailure.nonRetryable(
        'The requested person was not found in Hub',
        'UserNotFound',
      );
    }

    usersToProcess = [user];
    const userRecord = user as unknown as Record<string, unknown>;
    const fieldsWithValues = Object.keys(userRecord).filter(
      (k) => userRecord[k] !== null && userRecord[k] !== undefined,
    );
    log.info(`Found user in Hub with ${fieldsWithValues.length} fields`);
    // No phone number in clear: only whether one is set
    log.info(
      `Critical fields: jobTitle=${user.jobTitle}, departmentName=${user.departmentName}, mobilePhone ${user.mobilePhone ? 'set' : 'not set'}, location=${user.location}`,
    );
  } else {
    // For new hires: Fetch from HR system
    log.info(`[NEW HIRE PATH] targetEmail is falsy, fetching new hires from HR system`);
    const newHires = await fetchNewHires(tenantId, correlationId);
    usersToProcess = newHires;
  }

  // 4. Process each user through the onboarding journey
  const sodBlocked: SodBlockedPerson[] = [];
  const reviewExcludedSkips: string[] = [];
  /** `<target>: <reason>` for each target that answered without provisioning (UNPROVISIONED_PATCH) */
  const notProvisioned: string[] = [];
  /** Why the pipeline guard left a person unprovisioned, one entry per person (PIPELINE_GUARD_PATCH) */
  const pipelineSkips: string[] = [];
  /** People whose admin account children failed (onboarding-admin-tiers.ts) */
  const adminFailed: AdminAccountsFailed[] = [];
  for (const user of usersToProcess) {
    let currentUser = user;

    // Save to central identity hub (skip if we just fetched from Hub)
    if (!targetEmail) {
      currentStep = 'HUB_SAVE';
      await saveToHub(user, tenantId, correlationId);
      // Re-fetch the user to get the enriched/updated version from MongoDB
      const refreshedUser = await getUserByEmail(user.email, tenantId, correlationId);
      if (refreshedUser) {
        currentUser = refreshedUser;
        const currentUserRecord = currentUser as unknown as Record<string, unknown>;
        log.info(
          `Re-fetched user after Hub save, now has ${Object.keys(currentUserRecord).filter((k) => currentUserRecord[k] !== null && currentUserRecord[k] !== undefined).length} fields`,
        );
      }
    }

    // Policy engine calculates access rights (groups, licenses, attributes)
    currentStep = 'POLICY_CALC';
    let intent: Awaited<ReturnType<typeof evaluateUser>>;
    try {
      intent = await evaluateUser(currentUser, tenantId, correlationId);
    } catch (err: unknown) {
      // A BLOCK SoD policy refused this person: skip them, go on (onboarding-sod-block.ts)
      const reason = sodBlockReason(err);
      if (reason === undefined) throw err;
      sodBlocked.push(await recordSodBlock(currentUser.email, reason, tenantId, correlationId));
      continue;
    }
    // Resolve Identity for provisioning state tracking (Onion model). The targets left out as not
    // configured go on its timeline: a trailing argument, so no change to the commands.
    const identityRecord = await getIdentityByEmail(
      currentUser.email,
      tenantId,
      correlationId,
      notConfigured,
    );
    const identityId = identityRecord?._id ?? null;
    // Log lines name the person by identity id, never by email
    const who = identityId ? `identity ${identityId}` : 'a user without an Identity record';
    log.info(`Policy engine returned ${intent.operations.length} operations for ${who}`);

    // Pipeline status guard, before anything is provisioned (PIPELINE_GUARD_PATCH)
    const guardFirst = isPatched(PIPELINE_GUARD_PATCH);
    if (guardFirst) {
      const blocked = pipelineBlockReason(await getPipelineStatus(tenantId, correlationId));
      if (blocked) {
        log.info(`Nothing provisioned for ${who}: ${blocked}`);
        pipelineSkips.push(blocked);
        continue;
      }
    }

    // PAM: admin account children per tier; their failures end the run after the people
    const adminOps = (intent as { adminOperations?: Array<Record<string, unknown>> })
      .adminOperations;
    if (adminOps?.length && identityId) {
      const failures = await provisionAdminAccounts(
        adminOps,
        identityId,
        tenantId,
        CHILD_TENANT_PATCH,
      );
      if (failures.length > 0) adminFailed.push({ identityId, failures });
    }
    if (identityId) log.info(`Tracking provisioning state on Identity ${identityId}`);

    // Histories from before PIPELINE_GUARD_PATCH: after the admin accounts, PAUSED or STOPPED only
    if (!guardFirst) {
      const pipelineStatus = await getPipelineStatus(tenantId, correlationId);
      if (legacyPipelineBlockReason(pipelineStatus)) {
        log.info(`Pipeline status is ${pipelineStatus}: skipping provisioning for ${who}`);
        continue;
      }
    }

    // Dynamic Provisioning: Sequential so writeback from Entra can provide email for AD
    // Apply edge conditions to filter which systems this user flows to
    currentStep = 'TARGET_PUSH';
    const targetSystemNames = targetSystems.filter((s) => s && !notConfigured.includes(s));
    let identityRecordForProv = identityRecord;
    let currentUserForProv = currentUser;
    // Targets an access review excluded for this person (patch onboarding:review-exclusions)
    const reviewExcluded = await reviewExcludedTargets(
      identityId,
      targetSystemNames,
      tenantId,
      correlationId,
    );
    reviewExcludedSkips.push(...reviewExcluded);

    for (const system of targetSystemNames) {
      if (reviewExcluded.includes(system)) {
        log.info(`Skipping ${system} for ${who}: excluded by an access review`);
        continue;
      }
      const edgeData = await getEdgeConditions(system, tenantId, correlationId);
      if (
        edgeData &&
        !evaluateEdgeConditions(currentUserForProv as unknown as Record<string, unknown>, edgeData)
      ) {
        log.info(`Skipping ${system} for ${who}: filtered out by its edge conditions`);
        continue;
      }

      const provEntry = identityRecordForProv?.provisioning?.find(
        (p: { targetSystem: string }) => p.targetSystem === system,
      );
      const wasFirstProvision = isPatched(WRITEBACK_UNTIL_COMPLETE_PATCH)
        ? provEntry?.writebackComplete !== true
        : provEntry?.status === 'PENDING';
      const skipSynced = isPatched(SKIP_SYNCED_PATCH);
      const done = provEntry?.status === 'SYNCED' && provEntry.writebackComplete === true;
      if (skipSynced && done && !(syncToEntra && getSystemType(system) === 'entra')) {
        log.info(`${system} is already SYNCED for identity ${identityId}: skipped`);
        continue;
      }

      // The target's operations, and the end of the access a policy limits (durationDays)
      const systemOpsForTarget = targetOperations(intent.operations, system);
      const timeConstraintOptions = policyTimeConstraint(systemOpsForTarget, workflowNow());

      if (identityId)
        await setProvisioningStatus(
          identityId,
          system,
          'SYNCING',
          undefined,
          tenantId,
          undefined,
          undefined,
          correlationId,
        );
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
          const entraConfig = await getConnectorConfig('entra-id', tenantId, correlationId);
          // Groups, directory roles (the non-admin ones a policy assigns; PamFilterService moved
          // admin roles to the linked admin account) and licenses: an activity argument only
          const systemOps = systemOpsForTarget as unknown as Array<{
            type: 'group' | 'license' | 'role';
            action: 'add' | 'remove';
            targetId: string;
          }>;
          // An edit's sync (syncToEntra) never creates an account the identity's provisioning
          // entry says exists (mustExist). Trailing arguments: no change to the commands.
          provisionResult = await entraProxy.provisionUserToEntra(
            currentUserForProv,
            { operations: systemOps },
            (entraConfig as unknown as EntraConfig) ?? undefined,
            tenantId,
            correlationId,
            undefined,
            syncToEntra,
          );
        } else if (getSystemType(system) === 'ad') {
          const adConfig = await getConnectorConfig('ad', tenantId, correlationId);
          const systemOps = systemOpsForTarget as unknown as Array<{
            type: 'group' | 'license';
            action: 'add' | 'remove';
            targetId: string;
          }>;
          provisionResult = await adProxy.provisionUserToAd(
            currentUserForProv,
            { operations: systemOps },
            (adConfig as unknown as AdConfig) ?? undefined,
            tenantId,
            correlationId,
          );
        } else if (isQueuedConnector(system) && isPatched(CONNECTOR_QUEUE_PATCH)) {
          provisionResult = await provisionToQueuedConnector(
            system,
            currentUserForProv,
            systemOpsForTarget,
            tenantId,
            correlationId,
          );
        } else {
          // (user, intent, config, tenantId, correlationId), like provisionUserToEntra/Ad/Okta
          provisionResult = (await (provisionProxy as GenericConnectorActivities)[methodName](
            currentUserForProv,
            { operations: systemOpsForTarget },
            undefined,
            tenantId,
            correlationId,
          )) as
            | {
                success?: boolean;
                objectId?: string;
                generatedAttributes?: Record<string, unknown>;
              }
            | undefined;
        }

        const unprovisioned = unprovisionedReason(provisionResult);
        if (unprovisioned !== undefined && isPatched(UNPROVISIONED_PATCH)) {
          log.warn(`${system} did not provision ${who}: ${unprovisioned}`);
          if (identityId)
            await setProvisioningStatus(
              identityId,
              system,
              'ERROR',
              unprovisioned,
              tenantId,
              undefined,
              undefined,
              correlationId,
            );
          notProvisioned.push(`${system}: ${unprovisioned}`);
          continue;
        }

        const hasWritebackPayload =
          provisionResult?.objectId != null ||
          provisionResult?.generatedAttributes?.['distinguishedName'] != null;
        if (provisionResult?.success && wasFirstProvision && identityId && hasWritebackPayload) {
          const writebackSystem = normalizeTargetSystemForWriteback(system);
          const writeback = await writebackToIdentity(
            identityId,
            writebackSystem,
            provisionResult,
            tenantId,
            correlationId,
          );
          const writtenBack = !(writeback?.success === false && isPatched(UNPROVISIONED_PATCH));
          await setProvisioningStatus(
            identityId,
            system,
            'SYNCED',
            undefined,
            tenantId,
            writtenBack ? true : undefined,
            timeConstraintOptions,
            correlationId,
          );
          identityRecordForProv = await getIdentityByEmail(
            currentUserForProv.email,
            tenantId,
            correlationId,
          );
          if (identityRecordForProv?.profile) currentUserForProv = identityRecordForProv.profile;
          try {
            await writebackToHrSource(identityId, tenantId, correlationId);
          } catch (hrErr: unknown) {
            const message = hrErr instanceof Error ? hrErr.message : String(hrErr);
            log.error(`HR writeback failed (non-fatal): ${message}`);
          }
        } else {
          // Success with nothing (left) to write back completes the writeback (SKIP_SYNCED_PATCH)
          if (identityId)
            await setProvisioningStatus(
              identityId,
              system,
              'SYNCED',
              undefined,
              tenantId,
              skipSynced && provisionResult?.success === true ? true : undefined,
              timeConstraintOptions,
              correlationId,
            );
        }
        await recordProvisioningOutcome(tenantId, true, correlationId);
      } catch (err: unknown) {
        // The activity's own (masked) reason: ActivityFailure's message only names the activity.
        // An activity argument's value, so no change to the command sequence.
        const message = reasonOf(err);
        log.error(`Provisioning to ${system} failed: ${message}`);
        const created = wasFirstProvision ? createdEntraAccount(err) : undefined;
        if (identityId && created && isPatched(ENTRA_CREATED_WRITEBACK_PATCH)) {
          try {
            await writebackToIdentity(
              identityId,
              normalizeTargetSystemForWriteback(system),
              created,
              tenantId,
              correlationId,
            );
          } catch (writebackErr: unknown) {
            const reason = writebackErr instanceof Error ? writebackErr.message : writebackErr;
            log.error(`Writeback of the account ${system} created failed: ${reason}`);
          }
        }
        if (identityId)
          await setProvisioningStatus(
            identityId,
            system,
            'ERROR',
            message,
            tenantId,
            undefined,
            undefined,
            correlationId,
          );
        await recordProvisioningOutcome(tenantId, false, correlationId);
        throw err;
      }
    }
  }

  if (sodBlocked.length > 0) throw sodBlockFailure(sodBlocked, usersToProcess.length);
  if (adminFailed.length > 0) throw adminAccountsFailure(adminFailed, usersToProcess.length);

  currentStep = 'COMPLETED';
  const completed = `Dynamic onboarding complete for ${targetEmail || 'all users'}.`;
  let result = withSkippedTargets(completed, targetSystems, notConfigured);
  result = withReviewExcludedTargets(result, reviewExcludedSkips);
  result = withNotProvisioned(result, notProvisioned);
  return withPipelineSkips(result, pipelineSkips, usersToProcess.length);
}
