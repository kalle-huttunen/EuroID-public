/**
 * A privileged session's calls to the target systems: enable or disable one account of the
 * linked admin identity, and say what happened. Each connector activity runs on the connector's
 * queue with CONNECTOR_RETRY; what still fails after the retries is a `failed` step, never a
 * throw. Targets without an enable and disable step (GitHub, ServiceNow, the targets that keep
 * no account, unknown ones) are `skipped`: their accounts keep the state they have.
 *
 * Workflow code: bundled into privilegedSessionWorkflow, so it must stay deterministic.
 */
import { proxyActivities, ActivityFailure } from '@temporalio/workflow';
import type { ConfigActivities } from '../activities/config.activities';
import type { EntraActivities } from '../activities/entra.activities';
import type { AdActivities } from '../activities/ad.activities';
import type { ScimActivities } from '../activities/scim.activities';
import type { OktaActivities } from '../activities/okta.activities';
import type { EntraConfig } from '../modules/connectors/entra-connector/entra.interface';
import type { AdConfig } from '../modules/connectors/ad-connector/ad.interface';
import type { SCIMConnectorConfig } from '../modules/connectors/scim-connector/scim.interface';
import type { PamAccountResult, PamSessionTarget } from '../shared/types/pam-session';
import { QUEUE_NAMES } from '../infrastructure/temporal/task-queue.config';
import { CONNECTOR_RETRY, QUERY_RETRY } from '../infrastructure/config/retry-policies';
import { offboardingTargetKind } from './offboarding-targets';

const { getConnectorConfig } = proxyActivities<ConfigActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});
const connectorOptions = { startToCloseTimeout: '1m', retry: CONNECTOR_RETRY } as const;
const entra = proxyActivities<Pick<EntraActivities, 'enableEntraUser' | 'disableEntraUser'>>({
  taskQueue: QUEUE_NAMES['entra'],
  ...connectorOptions,
});
const ad = proxyActivities<Pick<AdActivities, 'setAdUserEnabled'>>({
  taskQueue: QUEUE_NAMES['ad'],
  ...connectorOptions,
});
const scim = proxyActivities<Pick<ScimActivities, 'setScimUserActive'>>({
  taskQueue: QUEUE_NAMES['scim'],
  ...connectorOptions,
});
const okta = proxyActivities<Pick<OktaActivities, 'setOktaUserEnabled'>>({
  taskQueue: QUEUE_NAMES['okta'],
  ...connectorOptions,
});

export interface SessionAccountContext {
  tenantId: string;
  workflowId: string;
  /** The admin identity's UPN: the login where no account id is stored. */
  login?: string;
}

export interface SessionAccountStep {
  system: string;
  outcome: 'done' | 'not-found' | 'skipped' | 'failed';
  reason?: string;
}

/** Entra ID, AD, SCIM and Okta have an enable and disable step. */
export function hasEnableStep(targetSystem: string): boolean {
  const kind = offboardingTargetKind(targetSystem);
  return kind === 'entra' || kind === 'ad' || kind === 'scim' || kind === 'okta';
}

/** The activity's own message (ActivityFailure only says which activity failed). */
function reasonOf(err: unknown): string {
  if (err instanceof ActivityFailure && err.cause) return err.cause.message;
  return err instanceof Error ? err.message : String(err);
}

function stepOf(system: string, result: PamAccountResult): SessionAccountStep {
  return result.outcome === 'done'
    ? { system, outcome: 'done' }
    : { system, outcome: 'not-found', reason: 'the target has no such account' };
}

/** Enable (or disable) the admin identity's account in one target. */
export async function setAccountEnabled(
  target: PamSessionTarget,
  enabled: boolean,
  ctx: SessionAccountContext,
): Promise<SessionAccountStep> {
  const { targetSystem: system, externalId } = target;
  const { tenantId, workflowId, login } = ctx;
  const failed = (reason: string): SessionAccountStep => ({ system, outcome: 'failed', reason });
  try {
    switch (offboardingTargetKind(system)) {
      case 'entra': {
        const config = await getConnectorConfig('entra-id', tenantId, workflowId);
        const account = externalId ?? login;
        if (!account) return failed('no Entra ID object id or UPN recorded for the account');
        const call = enabled ? entra.enableEntraUser : entra.disableEntraUser;
        const found = await call(
          account,
          tenantId,
          workflowId,
          (config ?? undefined) as unknown as EntraConfig,
        );
        return stepOf(system, { outcome: found ? 'done' : 'not-found' });
      }
      case 'ad': {
        const config = await getConnectorConfig('ad', tenantId, workflowId);
        if (!config) return failed('AD connector config not found on the canvas');
        if (!externalId) return failed('no AD distinguished name recorded for the account');
        const result = await ad.setAdUserEnabled(
          externalId,
          enabled,
          config as unknown as AdConfig,
          tenantId,
          workflowId,
        );
        return stepOf(system, result);
      }
      case 'scim': {
        const config = await getConnectorConfig('scim', tenantId, workflowId);
        if (!config) return failed('SCIM connector config not found on the canvas');
        const result = await scim.setScimUserActive(
          config as unknown as SCIMConnectorConfig,
          externalId,
          enabled,
          tenantId,
          workflowId,
          login,
        );
        return stepOf(system, result);
      }
      case 'okta': {
        if (!externalId && !login) return failed('no Okta id or login recorded for the account');
        const result = await okta.setOktaUserEnabled(
          externalId,
          login ?? '',
          enabled,
          tenantId,
          workflowId,
        );
        return stepOf(system, result);
      }
      default:
        return { system, outcome: 'skipped', reason: 'no enable or disable step for this target' };
    }
  } catch (err: unknown) {
    return failed(reasonOf(err));
  }
}
