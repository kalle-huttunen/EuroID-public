/**
 * Webhook labels and the rules the backend applies (`modules/event-subscriptions`): the event
 * types a subscription can name, what a delivery's state means, the headers a subscription may
 * set, the signing secret's limits, and where an exhausted delivery lands in the dead-letter queue.
 */
import dayjs from 'dayjs';
import type { IWebhookDelivery, WebhookDeliveryStatus, WebhookStatus } from '../../interfaces';

export const STATUS_LABEL: Record<WebhookStatus, string> = {
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  DISABLED: 'Disabled',
};

/** Ant Design Tag preset per status (theme-driven, no raw colors). */
export const STATUS_TAG: Record<WebhookStatus, string> = {
  ACTIVE: 'success',
  PAUSED: 'warning',
  DISABLED: 'default',
};

export const DELIVERY_STATUS_LABEL: Record<WebhookDeliveryStatus, string> = {
  PENDING: 'Sending',
  DELIVERED: 'Delivered',
  FAILED: 'Failed',
};

export const DELIVERY_STATUS_TAG: Record<WebhookDeliveryStatus, string> = {
  PENDING: 'processing',
  DELIVERED: 'success',
  FAILED: 'error',
};

/**
 * Event types a subscription can name: the backend's `DomainEventType` values
 * (`backend/src/infrastructure/events/event-types.ts`) without `webhook.*` and `dlq.*`, which
 * EventDeliveryService never delivers (loop guard). No API lists them; the test compares this
 * list with `backend/test/fixtures/webhook-event-types.json`, which a backend test keeps equal
 * to the enum. The API accepts any pattern (1 to 100 characters), so this list is the form's.
 */
export const WEBHOOK_EVENT_TYPES: readonly string[] = [
  'access_request.created',
  'access_request.closed',
  'access_review.campaign_created',
  'access_review.campaign_activated',
  'access_review.campaign_completed',
  'access_review.campaign_cancelled',
  'access_review.item_approved',
  'access_review.item_revoked',
  'access_review.item_expired',
  'access_review.recertification_campaign_created',
  'access_review.item_escalated',
  'access_review.account_revoked',
  'access_review.membership_revoked',
  'access_review.exclusion_created',
  'access_review.exclusion_lifted',
  'admin_account.created',
  'admin_account.activated',
  'admin_account.deactivated',
  'admin_account.activation_pending',
  'admin_user.role_changed',
  'admin_user.password_reset_requested',
  'admin_user.password_reset_issued',
  'admin_user.password_reset_completed',
  'anomaly.detected',
  'anomaly.resolved',
  'compliance.report_generated',
  'connector.hr_sync_completed',
  'connector.health_changed',
  'connector.circuit_breaker_tripped',
  'connector.hr_sync_movers_requested',
  'connector.hr_sync_joiners_requested',
  'credential.expiring_soon',
  'credential.inventory_updated',
  'discovery.completed',
  'distributed_transaction.rollback_failed',
  'drift.detected',
  'drift.resolved',
  'drift.circuit_breaker_tripped',
  'entitlement.updated',
  'entitlement.expired',
  'entitlement.expiring_soon',
  'entitlement.expiring_tomorrow',
  'entitlement.expiry_failed',
  'entitlement.expiry_retry_requested',
  'entitlement.expiry_removed_manually',
  'hr_writeback.completed',
  'identity.created',
  'identity.updated',
  'identity.deleted',
  'identity.status_changed',
  'identity.offboard_requested',
  'identity.leaver_detected',
  'identity.leaver_offboarding_started',
  'identity.joiner_onboarding_started',
  'identity.joiner_onboarding_waiting',
  'identity.offboarding_completed',
  'identity.offboarding_target_removed_manually',
  'identity.offboard_impact_query',
  'identity.entitlements_query',
  'identity.provision_requested',
  'identity.move_requested',
  'identity.correlated',
  'identity.correlation_conflict',
  'identity.sources_changed',
  'identity.sources_approaching_limit',
  'intelligence.peer_group_updated',
  'intelligence.peer_deviation_detected',
  'intelligence.reviewer_quality_scored',
  'invite.created',
  'invite.cancelled',
  'joiner.batch_paused',
  'joiner.batch_approved',
  'joiner.batch_rejected',
  'joiner.policy_updated',
  'leaver.batch_paused',
  'leaver.batch_approved',
  'leaver.batch_rejected',
  'leaver.policy_updated',
  'mover.started',
  'mover.completed',
  'mover.failed',
  'mover.batch_paused',
  'mover.batch_approved',
  'mover.batch_rejected',
  'mover.policy_updated',
  'nhi.created',
  'nhi.revoked',
  'nhi.kill_switch_engaged',
  'nhi.delegated',
  'nhi.credential_issued',
  'nhi.credential_rotated',
  'nhi.owner_lost',
  'nhi.owner_changed',
  'notification.email_retry',
  'orphan.detected',
  'pipeline.deployed',
  'pipeline.paused',
  'pipeline.circuit_breaker_triggered',
  'policy.created',
  'policy.updated',
  'policy.deleted',
  'policy.evaluated',
  'provisioning.started',
  'provisioning.completed',
  'provisioning.failed',
  'provisioning.deprovisioned',
  'reconciliation.drift_threshold_exceeded',
  'risk_scores.calculated',
  'simulation.completed',
  'sod_policy.created',
  'sod_policy.updated',
  'sod_policy.deleted',
  'tenant.identity_limit_exceeded',
];

const domainOf = (type: string) => type.slice(0, type.indexOf('.'));

/**
 * Select options: every event (`*`), then per domain its wildcard (`identity.*`) and its types.
 * The backend matches `*` per dot segment, and every event type has two segments.
 */
export function eventTypeOptions() {
  const groups = new Map<string, string[]>();
  for (const type of WEBHOOK_EVENT_TYPES) {
    const domain = domainOf(type);
    groups.set(domain, [...(groups.get(domain) ?? []), type]);
  }
  return [
    { label: 'All', options: [{ value: '*', label: 'Every event (*)' }] },
    ...[...groups].map(([domain, types]) => ({
      label: domain,
      options: [
        { value: `${domain}.*`, label: `Every ${domain} event (${domain}.*)` },
        ...types.map((type) => ({ value: type, label: type })),
      ],
    })),
  ];
}

/** Most event types a subscription can name (backend zod schema). */
export const MAX_EVENT_TYPES = 50;

/** Signing secret length the backend accepts. */
export const SECRET_MIN_LENGTH = 16;
export const SECRET_MAX_LENGTH = 256;

/** A random 256-bit signing secret, base64url (43 characters), from the browser's CSPRNG. */
export function generateSigningSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** An HTTP header name (token) without `.` and `$`, which the stored map's keys cannot hold. */
const HEADER_NAME = /^[A-Za-z0-9!#%&'*+^_`|~-]+$/;
/** Set on every delivery by EuroID or the HTTP client; a custom value breaks the request or its signature. */
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'host']);

/** Why a custom header name cannot be used, or undefined when it can. */
export function headerNameProblem(name: string): string | undefined {
  if (!HEADER_NAME.test(name)) {
    return 'Letters, digits and - only (no spaces, dots or colons).';
  }
  const lower = name.toLowerCase();
  if (RESERVED_HEADERS.has(lower) || lower.startsWith('x-euroid-')) {
    return `${name} is set by EuroID on every delivery.`;
  }
  return undefined;
}

/** Longest header value the backend accepts. */
export const HEADER_VALUE_MAX_LENGTH = 2000;

/**
 * The text the retry poller wrote, before it stopped reading such deliveries, on a delivery whose
 * subscription was paused, deleted or no longer named the event when a retry was due. Rows from
 * then keep it until they expire (30 days).
 */
export const SUBSCRIPTION_INACTIVE_ERROR = 'Subscription no longer active';

/** When a failed delivery is sent again, and whether that time has passed. */
export function retryOf(
  delivery: IWebhookDelivery,
  now: number,
): { at: string; passed: boolean } | undefined {
  if (delivery.status !== 'FAILED' || !delivery.nextRetryAt) return undefined;
  return { at: delivery.nextRetryAt, passed: dayjs(delivery.nextRetryAt).valueOf() <= now };
}

/**
 * A failed delivery whose retry waits for its subscription: one with a retry ahead while the
 * subscription is not active (the retry poller reads only active subscriptions' deliveries), or
 * one the poller marked inactive. It keeps its attempts and is sent once the subscription is
 * active and names the event.
 */
export function waitsForSubscription(
  delivery: IWebhookDelivery,
  subscriptionActive: boolean,
): boolean {
  if (delivery.status !== 'FAILED') return false;
  return (
    delivery.lastError === SUBSCRIPTION_INACTIVE_ERROR ||
    (!subscriptionActive && Boolean(delivery.nextRetryAt))
  );
}

/**
 * A failed delivery without a retry ahead may be in the dead-letter queue: it is captured there
 * after its last attempt failed (5 attempts unless the deployment sets another limit). One that
 * waits for its subscription still has attempts left, so it is not.
 */
export function mayBeDeadLettered(
  delivery: IWebhookDelivery,
  now: number,
  subscriptionActive = true,
): boolean {
  if (delivery.status !== 'FAILED' || waitsForSubscription(delivery, subscriptionActive)) {
    return false;
  }
  const retry = retryOf(delivery, now);
  return !retry || retry.passed;
}

/**
 * The dead-letter `source` of a subscription's exhausted deliveries
 * (`webhook:<subscription>:<event type>`, EventDeliveryService.captureToDeadLetter); without an
 * event type, the prefix of all of them.
 */
export const deadLetterSource = (subscriptionId: string, eventType?: string) =>
  `webhook:${subscriptionId}:${eventType ?? ''}`;

/** The dead-letter page filtered by a source prefix. */
export const deadLetterHref = (source: string) =>
  `/dead-letter?source=${encodeURIComponent(source)}`;
