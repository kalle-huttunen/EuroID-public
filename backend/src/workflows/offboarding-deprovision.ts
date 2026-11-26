/**
 * Offboarding: remove one target's account and say what happened (deprovisioned, already gone,
 * not applicable, failed with the reason). Each connector activity runs on the connector's queue
 * with CONNECTOR_RETRY; what still fails after the retries is a `failed` result, never a throw,
 * so the other targets are still attempted.
 *
 * Workflow code: bundled into offboardingWorkflow, so it must stay deterministic.
 */
import { proxyActivities, ActivityFailure } from '@temporalio/workflow';
import type { ConfigActivities } from '../activities/config.activities';
import type { EntraActivities } from '../activities/entra.activities';
import type { AdActivities } from '../activities/ad.activities';
import type { ScimActivities } from '../activities/scim.activities';
import type { OktaActivities } from '../activities/okta.activities';
import type { GitHubActivities } from '../activities/github.activities';
import type { ServiceNowActivities } from '../activities/servicenow.activities';
import type { EntraConfig } from '../modules/connectors/entra-connector/entra.interface';
import type { AdConfig } from '../modules/connectors/ad-connector/ad.interface';
import type { SCIMConnectorConfig } from '../modules/connectors/scim-connector/scim.interface';
import type { OffboardingSystemResult } from '../shared/types/deprovision';
import { QUEUE_NAMES } from '../infrastructure/temporal/task-queue.config';
import { CONNECTOR_RETRY, QUERY_RETRY } from '../infrastructure/config/retry-policies';
import { offboardingTargetKind } from './offboarding-targets';
import { isPatched } from './workflow-versioning';

/**
 * AD reports what it did (deprovisionAdUser): "no such object" for the stored DN is already
 * gone, and its failure reason is masked. Before it, disableAdUser answered only true/false.
 */
const AD_OUTCOME_PATCH = 'offboarding:ad-deprovision-outcome';

const { getConnectorConfig } = proxyActivities<ConfigActivities>({
  startToCloseTimeout: '10s',
  retry: QUERY_RETRY,
});
const connectorOptions = { startToCloseTimeout: '1m', retry: CONNECTOR_RETRY } as const;
const entra = proxyActivities<Pick<EntraActivities, 'deleteUser'>>({
  taskQueue: QUEUE_NAMES['entra'],
  ...connectorOptions,
});
const ad = proxyActivities<Pick<AdActivities, 'disableAdUser' | 'deprovisionAdUser'>>({
  taskQueue: QUEUE_NAMES['ad'],
  ...connectorOptions,
});
const scim = proxyActivities<Pick<ScimActivities, 'deprovisionScimUser'>>({
  taskQueue: QUEUE_NAMES['scim'],
  ...connectorOptions,
});
const okta = proxyActivities<Pick<OktaActivities, 'deprovisionOktaUser'>>({
  taskQueue: QUEUE_NAMES['okta'],
  ...connectorOptions,
});
// GitHub and ServiceNow have no queue of their own: the default queue, like other connectors
const defaultQueue = proxyActivities<
  Pick<GitHubActivities, 'deprovisionGitHubUser'> &
    Pick<ServiceNowActivities, 'deprovisionServiceNowUser'>
>(connectorOptions);

export interface DeprovisionTarget {
  targetSystem: string;
  /** The account's id in the target, from the identity's account record (writeback). */
  externalId?: string;
  /**
   * The provisioning entry's status. SYNCING, ERROR, PENDING: onboarding never finished, so the
   * account may be half-created; a failure says so in its reason. DEPROVISIONED: an admin
   * identity's entry a PAM deactivation marked so (getOffboardingTargets), reported as is.
   */
  status?: string;
}

export interface OffboardingContext {
  userId: string;
  userEmail: string;
  tenantId: string;
  workflowId: string;
}

/** Provisioning there never completed, so the account may be half-created. */
const UNFINISHED_STATUSES: readonly string[] = ['SYNCING', 'ERROR', 'PENDING'];

function failed(system: string, reason: string): OffboardingSystemResult {
  return { system, outcome: 'failed', reason };
}

/** The activity's own message (ActivityFailure only says which activity failed). */
function reasonOf(err: unknown): string {
  if (err instanceof ActivityFailure && err.cause) return err.cause.message;
  return err instanceof Error ? err.message : String(err);
}

/** Connector config on the canvas (Entra, AD and SCIM take it as an argument). */
async function canvasConfig(
  connectorId: string,
  ctx: OffboardingContext,
): Promise<Record<string, unknown> | null> {
  return getConnectorConfig(connectorId, ctx.tenantId, ctx.workflowId);
}

/**
 * Remove the identity's account in one target. `entraConfig` is the Entra config the caller
 * already read (identity without provisioning state), so it is not read twice.
 */
export async function deprovisionTarget(
  target: DeprovisionTarget,
  ctx: OffboardingContext,
  entraConfig?: Record<string, unknown>,
): Promise<OffboardingSystemResult> {
  const result = await deprovisionAccount(target, ctx, entraConfig);
  // Every status that reached here before DEPROVISIONED did is handled as it was (no patch)
  if (result.outcome !== 'failed' || !UNFINISHED_STATUSES.includes(target.status ?? '')) {
    return result;
  }
  return {
    ...result,
    reason: `provisioning to this target never completed (${target.status}): ${result.reason}`,
  };
}

async function deprovisionAccount(
  target: DeprovisionTarget,
  ctx: OffboardingContext,
  entraConfig?: Record<string, unknown>,
): Promise<OffboardingSystemResult> {
  const { targetSystem: system, externalId } = target;
  const { userId, userEmail, tenantId, workflowId } = ctx;
  const kind = offboardingTargetKind(system);
  try {
    switch (kind) {
      case 'not-applicable':
        return {
          system,
          outcome: 'not-applicable',
          reason: 'keeps no account (notification or log target)',
        };
      case 'unknown':
        return failed(system, 'offboarding has no deprovision for this target');
      case 'entra': {
        const config = entraConfig ?? (await canvasConfig('entra-id', ctx));
        if (!config) return failed(system, 'Entra ID connector config not found on the canvas');
        // The stored objectId when written back, else the email as UPN (Graph takes either);
        // without a stored id the activity also looks the user up by mail before saying gone
        const result = await entra.deleteUser(
          externalId ?? userEmail,
          config as unknown as EntraConfig,
          userId,
          tenantId,
          workflowId,
          externalId === undefined,
        );
        // An activity worker from before the outcome field (rolling deploy): a completed delete
        const outcome = result.outcome ?? 'deprovisioned';
        return {
          system,
          outcome,
          detail: outcome === 'deprovisioned' ? 'deleted' : 'no such user',
        };
      }
      case 'ad': {
        const config = await canvasConfig('ad', ctx);
        if (!config) return failed(system, 'AD connector config not found on the canvas');
        if (!externalId) return failed(system, 'no AD distinguished name recorded for the account');
        if (isPatched(AD_OUTCOME_PATCH)) {
          // userId: only an argument more (the event's identity), the command is unchanged
          const r = await ad.deprovisionAdUser(
            externalId,
            config as unknown as AdConfig,
            tenantId,
            workflowId,
            userId,
          );
          return { system, outcome: r.outcome, detail: r.detail };
        }
        const disabled = await ad.disableAdUser(
          externalId,
          config as unknown as AdConfig,
          tenantId,
          workflowId,
        );
        return disabled
          ? { system, outcome: 'deprovisioned', detail: 'disabled' }
          : failed(system, 'AD connector config incomplete (no host)');
      }
      case 'scim': {
        const config = await canvasConfig('scim', ctx);
        if (!config) return failed(system, 'SCIM connector config not found on the canvas');
        // Without a stored id the activity reads the identity's UPN and email (not history)
        const { outcome, detail } = await scim.deprovisionScimUser(
          config as unknown as SCIMConnectorConfig,
          externalId,
          tenantId,
          workflowId,
          userEmail,
          userId,
        );
        return { system, outcome, detail };
      }
      case 'okta': {
        const r = await okta.deprovisionOktaUser(
          externalId,
          userEmail,
          tenantId,
          workflowId,
          userId,
        );
        return { system, outcome: r.outcome, detail: r.detail };
      }
      case 'github': {
        // The activity reads the identity's GitHub login itself (not into history). Only the
        // arguments are new, not the command: histories from before them replay unchanged.
        const r = await defaultQueue.deprovisionGitHubUser(
          userEmail,
          tenantId,
          workflowId,
          externalId,
          userId,
        );
        return { system, outcome: r.outcome, detail: r.detail };
      }
      case 'servicenow': {
        const r = await defaultQueue.deprovisionServiceNowUser(
          externalId,
          userEmail,
          tenantId,
          workflowId,
          userId,
        );
        return { system, outcome: r.outcome, detail: r.detail };
      }
    }
  } catch (err: unknown) {
    return failed(system, reasonOf(err));
  }
}
