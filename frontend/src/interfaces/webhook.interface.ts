/**
 * Outbound webhooks (backend `modules/event-subscriptions`): subscriptions and their delivery
 * attempts. Matches GET /event-subscriptions (newest first), GET /event-subscriptions/:id/deliveries
 * and POST /event-subscriptions/:id/test. The routes take the subscription's `_id` (ObjectId). The
 * generated types carry no response bodies for these routes, so the shapes follow the service.
 */

/** ACTIVE receives events; PAUSED and DISABLED receive none (nothing sets DISABLED today). */
export type WebhookStatus = 'ACTIVE' | 'PAUSED' | 'DISABLED';

export interface IWebhookSubscription {
  _id: string;
  tenantId: string;
  name: string;
  type: 'WEBHOOK';
  status: WebhookStatus;
  filters: {
    /** Event types or patterns: `identity.created`, `identity.*`, `*`. */
    eventTypes: string[];
    /** Stored when sent, but no delivery reads it. */
    severityMin?: string;
  };
  webhook: {
    url: string;
    /**
     * Names of the custom headers sent with every delivery. Their values are write-only, like the
     * signing secret: the API never answers them.
     */
    headerNames: string[];
    /** A signing secret is stored (encrypted at rest); the API never answers it. */
    hasSigningSecret: boolean;
  };
  createdBy?: string;
  createdAt: string;
  updatedAt?: string;
}

/** POST /event-subscriptions body. */
export interface IWebhookCreate {
  name: string;
  filters: { eventTypes: string[] };
  webhook: { url: string; headers?: Record<string, string>; signingSecret: string };
}

/**
 * PATCH /event-subscriptions/:id body: only what changes. `filters` replaces the whole object.
 * `webhook.headers` is the complete set of custom headers after the edit: a header sent as `null`
 * keeps its stored value, a stored header left out is removed.
 */
export interface IWebhookUpdate {
  name?: string;
  status?: WebhookStatus;
  filters?: { eventTypes: string[]; severityMin?: string };
  webhook?: { url?: string; headers?: Record<string, string | null>; signingSecret?: string };
}

/**
 * PENDING: being sent (the first POST or a retry); `nextRetryAt` is when the sender's lease ends,
 * after which the retry poller sends it again. DELIVERED: a 2xx answer. FAILED: the last attempt
 * failed; `nextRetryAt` is when the retry poller sends it again, absent once the attempts ran out.
 */
export type WebhookDeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

/** One delivery of one event to one subscription, with its retries. Kept 30 days. */
export interface IWebhookDelivery {
  /** Also the `X-EuroID-Delivery` header the receiver got. */
  _id: string;
  tenantId: string;
  subscriptionId: string;
  eventType: string;
  eventId: string;
  /** The JSON body sent (ids only); absent on attempts recorded before it was kept. */
  body?: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  /** The receiver's last HTTP status, absent when it could not be reached. */
  httpStatus?: number;
  attempts: number;
  nextRetryAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt?: string;
}

/** POST /event-subscriptions/:id/test: one signed `webhook.test` POST, not stored. */
export interface IWebhookTestResult {
  success: boolean;
  subscriptionId: string;
  /** The `X-EuroID-Delivery` header value the receiver got. */
  deliveryId: string;
  eventType: string;
  httpStatus?: number;
  error?: string;
  message: string;
}
