/**
 * Onboarding and admin account provisioning calls to Okta and SCIM. worker.ts registers their
 * activities only on the plugin queues (provisioning-okta, provisioning-scim), so these proxies
 * route there. SCIM takes (config, user, tenantId, correlationId) and needs the canvas config;
 * Okta resolves its own.
 *
 * Workflow code: bundled into those workflows, so it must stay deterministic (no I/O, clock or
 * randomness outside activities).
 */
import { proxyActivities, log, ApplicationFailure } from '@temporalio/workflow';
import type { ConfigActivities } from '../activities/config.activities';
import type { OktaActivities } from '../activities/okta.activities';
import type { ScimActivities } from '../activities/scim.activities';
import type { StandardUserDto } from '../shared/dtos/standard-user.dto';
import type { OktaProvisioningIntent } from '../modules/connectors/okta-connector/okta.interface';
import type { SCIMConnectorConfig } from '../modules/connectors/scim-connector/scim.interface';
import { normalizeSystemName } from '../shared/utils/normalize-system-name';
import { QUEUE_NAMES } from '../infrastructure/temporal/task-queue.config';
import {
  CONNECTOR_RETRY,
  HEALTH_CHECK_RETRY,
  QUERY_RETRY,
} from '../infrastructure/config/retry-policies';

const { getConnectorConfig } = proxyActivities<ConfigActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});
const oktaProxy = proxyActivities<Pick<OktaActivities, 'provisionUserToOkta'>>({
  taskQueue: QUEUE_NAMES['okta'],
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});
const scimProxy = proxyActivities<Pick<ScimActivities, 'provisionUserToScim'>>({
  taskQueue: QUEUE_NAMES['scim'],
  startToCloseTimeout: '1m',
  retry: CONNECTOR_RETRY,
});
const oktaHealthProxy = proxyActivities<Pick<OktaActivities, 'checkOktaHealth'>>({
  taskQueue: QUEUE_NAMES['okta'],
  startToCloseTimeout: '10s',
  retry: HEALTH_CHECK_RETRY,
});
const scimHealthProxy = proxyActivities<Pick<ScimActivities, 'checkScimHealth'>>({
  taskQueue: QUEUE_NAMES['scim'],
  startToCloseTimeout: '10s',
  retry: HEALTH_CHECK_RETRY,
});

/** Okta or SCIM: connectors whose activities live only on their own queue. */
export function isQueuedConnector(system: string): boolean {
  const n = normalizeSystemName(system);
  return n === 'okta' || n === 'scim';
}

/** Health of Okta (config resolved by the activity) or SCIM (config from the canvas). */
export async function checkQueuedConnectorHealth(
  system: string,
  tenantId: string,
  correlationId: string,
): Promise<boolean> {
  if (normalizeSystemName(system) === 'okta') {
    return oktaHealthProxy.checkOktaHealth(undefined, tenantId, correlationId);
  }
  const config = await getConnectorConfig('scim', tenantId, correlationId);
  if (!config) {
    log.error(`No SCIM connector config on the canvas for ${system}`);
    return false;
  }
  const status = await scimHealthProxy.checkScimHealth(
    config as unknown as SCIMConnectorConfig,
    tenantId,
    correlationId,
  );
  return status.healthy;
}

/** Provision to Okta (user, intent, config, ...) or SCIM (config, user, ...) on their queues. */
export async function provisionToQueuedConnector(
  system: string,
  user: StandardUserDto,
  operations: unknown[],
  tenantId: string,
  correlationId: string,
): Promise<{ success?: boolean }> {
  if (normalizeSystemName(system) === 'okta') {
    const intent = { operations } as OktaProvisioningIntent;
    return oktaProxy.provisionUserToOkta(user, intent, undefined, tenantId, correlationId);
  }
  const config = await getConnectorConfig('scim', tenantId, correlationId);
  if (!config) {
    throw ApplicationFailure.nonRetryable(
      `No SCIM connector config on the canvas for ${system}`,
      'ConnectorConfigMissing',
    );
  }
  return scimProxy.provisionUserToScim(
    config as unknown as SCIMConnectorConfig,
    user,
    tenantId,
    correlationId,
  );
}
