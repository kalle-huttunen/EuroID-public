/**
 * Onboarding's health check step: every canvas target is checked in parallel before any user is
 * fetched, on its own queue (Entra ID, AD, Okta, SCIM) or on the default queue as
 * check<System>Health. An unhealthy target fails the run (HealthCheckFailed). An Entra ID with no
 * config anywhere, and an AD node with no config, are left out of the run instead, and the result
 * says so (withSkippedTargets).
 *
 * Workflow code: bundled into onboardingWorkflow, so it must stay deterministic (no I/O, clock or
 * randomness outside activities).
 */
import { proxyActivities, log, ApplicationFailure } from '@temporalio/workflow';
import type { ConfigActivities } from '../activities/config.activities';
import type { EntraActivities } from '../activities/entra.activities';
import type { AdActivities } from '../activities/ad.activities';
import type { EntraConfig } from '../modules/connectors/entra-connector/entra.interface';
import type { AdConfig } from '../modules/connectors/ad-connector/ad.interface';
import { getSystemType } from '../shared/utils/normalize-system-name';
import { QUEUE_NAMES } from '../infrastructure/temporal/task-queue.config';
import { HEALTH_CHECK_RETRY, QUERY_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';
import { checkQueuedConnectorHealth, isQueuedConnector } from './onboarding-queued-connectors';

/**
 * Okta and SCIM activities are registered only on their plugin queues (worker.ts), so they are
 * called there, SCIM with its (config, user, tenantId, correlationId) signature and the canvas
 * config. Histories from before this patch scheduled them on the default queue. Used by the
 * health check here and by onboardingWorkflow's provisioning.
 */
export const CONNECTOR_QUEUE_PATCH = 'onboarding:connector-queue-routing';

/**
 * Entra ID is asked whether it has a config to run on (isEntraConfigured: the canvas node's
 * config, else the tenant's installed connector config, else ENTRA_*). With none anywhere it is
 * left out of the run (no health check, no provisioning, no provisioning entry) and the result
 * says so; otherwise its health check runs on the canvas node's config, as provisioning does.
 * Histories from before this patch checked Entra ID with config undefined and failed the run
 * when nothing was configured.
 */
const ENTRA_NOT_CONFIGURED_PATCH = 'onboarding:entra-not-configured';

/**
 * AD is health-checked on its canvas node's config (getConnectorConfig('ad'), the config
 * provisioning gets; AD has no installed connector config or environment fallback). An AD node
 * without a config is left out of the run (no health check, no provisioning, no provisioning
 * entry) and the result says so, as for Entra ID; a config that is there but incomplete or does
 * not bind still fails the run. Histories from before this patch checked AD with config
 * undefined, which AdService answers false without trying LDAP: every run with AD on the canvas
 * failed with HealthCheckFailed.
 */
const AD_NOT_CONFIGURED_PATCH = 'onboarding:ad-not-configured';

/** Health check activities called by name (check<System>Health on the default queue). */
type NamedHealthChecks = Record<string, (...args: unknown[]) => Promise<unknown>>;

const { getConnectorConfig } = proxyActivities<ConfigActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});

// Health check proxies — per-connector queues
const entraHealthProxy = proxyActivities<
  Pick<EntraActivities, 'checkEntraHealth' | 'isEntraConfigured'>
>({
  taskQueue: QUEUE_NAMES['entra'],
  startToCloseTimeout: '10s',
  retry: HEALTH_CHECK_RETRY,
});
const adHealthProxy = proxyActivities<Pick<AdActivities, 'checkAdHealth'>>({
  taskQueue: QUEUE_NAMES['ad'],
  startToCloseTimeout: '10s',
  retry: HEALTH_CHECK_RETRY,
});
const defaultHealthProxy = proxyActivities<NamedHealthChecks>({
  startToCloseTimeout: '10s',
  retry: HEALTH_CHECK_RETRY,
});

/** Get connector proxy for health check (routes to correct queue) */
function getHealthProxy(system: string) {
  if (getSystemType(system) === 'entra') return entraHealthProxy;
  if (getSystemType(system) === 'ad') return adHealthProxy;
  return defaultHealthProxy;
}

/** Get health check method name for system (e.g., 'entra' -> 'checkEntraHealth') */
function getHealthMethodName(system: string) {
  const cap = (x: string) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : '');
  if (getSystemType(system) === 'entra') return 'checkEntraHealth';
  if (getSystemType(system) === 'ad') return 'checkAdHealth';
  return `check${cap(system)}Health`;
}

/**
 * Entra ID's health on the canvas node's config (the one provisioning gets; none: the service
 * picks the installed connector config, then ENTRA_*), or 'not-configured' when Entra ID has no
 * config anywhere (ENTRA_NOT_CONFIGURED_PATCH).
 */
async function checkEntraTarget(
  tenantId: string,
  correlationId: string,
): Promise<boolean | 'not-configured'> {
  const canvasConfig = await getConnectorConfig('entra-id', tenantId, correlationId);
  const config = (canvasConfig as unknown as EntraConfig | null) ?? undefined;
  if (!(await entraHealthProxy.isEntraConfigured(config, tenantId, correlationId))) {
    return 'not-configured';
  }
  return entraHealthProxy.checkEntraHealth(config, tenantId, correlationId);
}

/**
 * AD's health on its canvas node's config, or 'not-configured' when the node has none
 * (AD_NOT_CONFIGURED_PATCH).
 */
async function checkAdTarget(
  tenantId: string,
  correlationId: string,
): Promise<boolean | 'not-configured'> {
  const canvasConfig = await getConnectorConfig('ad', tenantId, correlationId);
  if (!canvasConfig) return 'not-configured';
  return adHealthProxy.checkAdHealth(canvasConfig as unknown as AdConfig, tenantId, correlationId);
}

/** A target's health on the config its provisioning gets, or 'not-configured'. */
async function checkTarget(
  system: string,
  tenantId: string,
  correlationId: string,
): Promise<unknown> {
  const proxy = getHealthProxy(system);
  const methodName = getHealthMethodName(system);
  // Every connector health check takes (config, tenantId, correlationId).
  if (getSystemType(system) === 'entra' && isPatched(ENTRA_NOT_CONFIGURED_PATCH)) {
    return checkEntraTarget(tenantId, correlationId);
  }
  if (getSystemType(system) === 'ad' && isPatched(AD_NOT_CONFIGURED_PATCH)) {
    return checkAdTarget(tenantId, correlationId);
  }
  if (isQueuedConnector(system) && isPatched(CONNECTOR_QUEUE_PATCH)) {
    return checkQueuedConnectorHealth(system, tenantId, correlationId);
  }
  return (proxy as NamedHealthChecks)[methodName](undefined, tenantId, correlationId);
}

/**
 * Checks the health of every target in parallel and fails the run (HealthCheckFailed) when one
 * is unreachable. Returns the targets left out of this run because nothing is configured for
 * them (Entra ID with no config anywhere, AD with no canvas config).
 */
export async function checkTargetHealth(
  targetSystems: string[],
  tenantId: string,
  correlationId: string,
): Promise<string[]> {
  const notConfigured: string[] = [];
  await Promise.all(
    targetSystems.filter(Boolean).map(async (system) => {
      try {
        const isHealthy = await checkTarget(system, tenantId, correlationId);
        if (isHealthy === 'not-configured') {
          log.warn(`${system} is not configured: left out of this run`);
          notConfigured.push(system);
          return;
        }
        if (!isHealthy)
          throw ApplicationFailure.nonRetryable(
            `Critical: ${system} is unreachable.`,
            'HealthCheckFailed',
          );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Health check failed for ${system}`, { error: message });
        throw err;
      }
    }),
  );
  return notConfigured;
}

/**
 * The run's result with the targets left out as not configured named after it, and, when that
 * was every target, that none was left to provision.
 */
export function withSkippedTargets(
  completed: string,
  targetSystems: string[],
  notConfigured: string[],
): string {
  if (notConfigured.length === 0) return completed;
  const noTargetLeft = targetSystems.filter(Boolean).every((s) => notConfigured.includes(s));
  return (
    `${completed} Skipped ${notConfigured.join(', ')}: not configured.` +
    (noTargetLeft ? ' No target left to provision.' : '')
  );
}
