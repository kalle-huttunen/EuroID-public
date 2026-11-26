/**
 * What the webhook subscription routes answer for a subscription. Built field by field from the
 * stored document, so neither the signing secret (not even its ciphertext) nor a custom header
 * value, nor any field added to the schema later, reaches an answer by default.
 */
import type { SubscriptionStatus, SubscriptionType } from './schemas/event-subscription.schema';
import { headerEntries } from './webhook-headers';

/** A subscription as the API answers it: the signing secret and header values stay stored. */
export interface EventSubscriptionView {
  _id: string;
  tenantId: string;
  name: string;
  type: SubscriptionType;
  status: SubscriptionStatus;
  filters: { eventTypes: string[]; severityMin?: string };
  webhook: {
    url: string;
    /** The custom headers' names; their values are write-only, like the signing secret. */
    headerNames: string[];
    hasSigningSecret: boolean;
  };
  createdBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** A stored subscription: a hydrated document or a lean() one (headers a Map or an object). */
export interface StoredSubscription {
  _id: unknown;
  tenantId: string;
  name: string;
  type: SubscriptionType;
  status: SubscriptionStatus;
  filters: { eventTypes: string[]; severityMin?: string };
  webhook: {
    url: string;
    headers?: Map<string, string> | Record<string, string>;
    signingSecret?: string;
  };
  createdBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** The answer for a stored subscription: listed fields only, so nothing stored leaks by default. */
export function toView(doc: StoredSubscription): EventSubscriptionView {
  return {
    _id: String(doc._id),
    tenantId: doc.tenantId,
    name: doc.name,
    type: doc.type,
    status: doc.status,
    filters: {
      eventTypes: [...doc.filters.eventTypes],
      ...(doc.filters.severityMin ? { severityMin: doc.filters.severityMin } : {}),
    },
    webhook: {
      url: doc.webhook.url,
      headerNames: headerEntries(doc.webhook.headers).map(([name]) => name),
      hasSigningSecret: !!doc.webhook.signingSecret,
    },
    ...(doc.createdBy !== undefined ? { createdBy: doc.createdBy } : {}),
    ...(doc.createdAt ? { createdAt: doc.createdAt } : {}),
    ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
  };
}
