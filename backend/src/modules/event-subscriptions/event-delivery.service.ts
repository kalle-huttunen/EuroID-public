/**
 * Event Delivery Service
 *
 * Listens to ALL domain events via wildcard, matches against active subscriptions,
 * and delivers via HTTP POST with HMAC-SHA256 signing.
 *
 * Retry: exponential backoff (1s, 5s, 25s, 125s, 625s), max 5 attempts. Each attempt re-sends
 * the body the first one built (stored on the attempt). After max retries, the delivery is
 * captured to the Dead Letter Queue as a `webhook.delivery_retry` event naming
 * handleDeliveryRetry, which the DLQ retry runs to deliver it once more.
 *
 * Who sends (2.0dl): every API replica and every worker runs the retry poller. A process sends a
 * delivery only while it holds it: PENDING with its lease in nextRetryAt
 * (WEBHOOK_DELIVERY_LEASE_MS), taken with one conditional update, and it records the outcome only
 * while that claim still holds. A send that has not finished when its lease runs out (the process
 * stopped) is taken by the poller and counts as an attempt.
 *
 * Body: ids only (webhook-payload.ts). filters.severityMin holds back an event with a lower
 * severity (subscription-filters.ts).
 *
 * A tenant that is not active (suspended, deprovisioned; TenantStatusService) gets no webhooks:
 * its events are not delivered and no attempt is stored, its due retries wait with their attempts
 * unchanged (sent once it is active again, within the attempts' 30-day TTL), and a dead-letter
 * retry of its delivery fails.
 *
 * Where a delivery goes (2.0dx): only to the subscription's URL. Redirects are not followed (a 3xx
 * answer is a failed delivery), the URL is checked again before each POST, and the host name is
 * resolved at connect by the SSRF guard's lookup, which hands the socket only addresses it
 * allows, so a DNS answer that changed since the URL was saved cannot reach a private address.
 */

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, UpdateQuery } from 'mongoose';
import { createHmac, randomUUID } from 'crypto';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { WebhookDeliveryRetryPayload } from '@infrastructure/events/event-payloads';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TenantStatusService } from '@infrastructure/multi-tenancy/tenant-status.service';
import {
  checkUrlWithoutDns,
  createSsrfSafeHttpsAgent,
} from '@infrastructure/url-validation/ssrf-guard';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import { handlerKey } from '../dead-letter/dead-letter-handler.registry';
import {
  EventSubscriptionService,
  WEBHOOK_URL_REFUSED,
  isDuplicateKey,
} from './event-subscription.service';
import { DeliveryAttempt, DeliveryAttemptDocument } from './schemas/delivery-attempt.schema';
import { EventSubscriptionDocument } from './schemas/event-subscription.schema';
import {
  headerEntries,
  webhookHeaderNameProblem,
  webhookHeaderValueProblem,
} from './webhook-headers';
import { buildWebhookBody, legacyWebhookBody } from './webhook-payload';
import { eventTypeCondition, meetsSeverityMin } from './subscription-filters';
import { isDeliveredToWebhooks } from './webhook-event-types';

/** Deliveries one poll claims per tenant at most. */
const RETRY_BATCH_SIZE = 50;

/** The error of a send that never finished: its lease ran out with no answer recorded. */
const SEND_INTERRUPTED =
  'The send was interrupted before the receiver answered (the process sending it stopped). It counts as an attempt.';

/** The outcome of a failed send, recorded on the attempt. */
interface Failure {
  /** The attempts the delivery has had, the failed one included. */
  attempts: number;
  body: Record<string, unknown>;
  message: string;
  httpStatus?: number;
}

/** Event type of a test delivery (POST /event-subscriptions/:id/test); no domain event has it. */
const TEST_EVENT_TYPE = 'webhook.test';

/** What POST /event-subscriptions/:id/test answers. */
export interface WebhookTestResult {
  /** The receiver answered 2xx. */
  success: boolean;
  subscriptionId: string;
  /** The X-EuroID-Delivery header the receiver got. */
  deliveryId: string;
  eventType: string;
  /** The receiver's HTTP status; absent when it could not be reached. */
  httpStatus?: number;
  error?: string;
  message: string;
}

/** A signed delivery: the JSON body and the headers to send it with. */
interface SignedRequest {
  json: string;
  headers: Record<string, string>;
}

/** The receiver's HTTP status of a failed POST, when it answered. */
const statusOf = (err: unknown) =>
  axios.isAxiosError(err) && err.response ? err.response.status : undefined;

/** The error text of a failed POST; a redirect answer says it was not followed. */
function postError(err: unknown, httpStatus: number | undefined, sender: string): string {
  if (httpStatus !== undefined && httpStatus >= 300 && httpStatus < 400) {
    return `The receiver answered with a redirect (${httpStatus}). ${sender} not follow redirects: use the URL it redirects to.`;
  }
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class EventDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventDeliveryService.name);
  private readonly http: AxiosInstance;
  private retryPollTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly maxRetries: number;
  private readonly leaseMs: number;

  constructor(
    @InjectModel(DeliveryAttempt.name)
    private readonly deliveryModel: Model<DeliveryAttemptDocument>,
    private readonly subscriptionService: EventSubscriptionService,
    private readonly encryptionService: EncryptionService,
    private readonly deadLetterService: DeadLetterService,
    private readonly configService: ConfigService,
    private readonly tenantStatus: TenantStatusService,
  ) {
    const timeoutMs =
      this.configService.get<number>('eventSubscriptions.WEBHOOK_DELIVERY_TIMEOUT_MS') ?? 10000;
    this.http = axios.create({
      timeout: timeoutMs,
      // Only the URL checked on save: a redirect answer is a failed delivery.
      maxRedirects: 0,
      // Resolves the host at connect and hands the socket only addresses the SSRF guard allows.
      httpsAgent: createSsrfSafeHttpsAgent(),
      // No proxy from the environment: the agent must make the connection it checked.
      proxy: false,
    });
    this.maxRetries =
      this.configService.get<number>('eventSubscriptions.WEBHOOK_MAX_RETRY_ATTEMPTS') ?? 5;
    this.leaseMs =
      this.configService.get<number>('eventSubscriptions.WEBHOOK_DELIVERY_LEASE_MS') ?? 60_000;
  }

  onModuleInit(): void {
    this.scheduleRetryPoll();
  }

  onModuleDestroy(): void {
    if (this.retryPollTimeout) {
      clearTimeout(this.retryPollTimeout);
      this.retryPollTimeout = null;
    }
  }

  // ── Wildcard listener ──────────────────────────────────────────────

  @OnEvent('**', { async: true })
  async handleDomainEvent(event: DomainEvent): Promise<void> {
    if (!event?.type || !event?.metadata?.tenantId) return;

    // Skip webhook/dlq events to prevent infinite loops
    if (!isDeliveredToWebhooks(event.type)) return;

    const tenantId = event.metadata.tenantId;
    let subscriptions: EventSubscriptionDocument[];
    try {
      // A suspended tenant's events go nowhere, and nothing is kept to send after a reactivation.
      if (!(await this.tenantStatus.isActive(tenantId))) return;
      subscriptions = await this.subscriptionService.getActiveSubscriptionsForEvent(
        event.type,
        tenantId,
      );
    } catch {
      return; // Subscription lookup failures must not crash the event bus
    }

    for (const sub of subscriptions) {
      if (!meetsSeverityMin(sub.filters?.severityMin, event.payload)) continue;
      // In the event's tenant: the attempt updates are tenant-scoped, and an event the outbox
      // poller publishes arrives without a request context.
      Promise.resolve(withTenantContext(tenantId, () => this.deliverWebhook(sub, event))).catch(
        (err) => {
          this.logger.error(
            `Webhook delivery error for sub=${String(sub._id)}: ${(err as Error).message}`,
          );
        },
      );
    }
  }

  /**
   * Dead-letter retry of a webhook delivery that ran out of attempts: posts the stored body once
   * more to the subscription, signed with its current secret, under the original delivery id.
   * Never emitted by a service: the DLQ runs this handler with the entry's stored event. No
   * `async: true` and suppressErrors: false, so a failure reaches the retry, which counts it.
   */
  @OnEvent(DomainEventType.WEBHOOK_DELIVERY_RETRY, { suppressErrors: false })
  async handleDeliveryRetry(event: DomainEvent<WebhookDeliveryRetryPayload>): Promise<void> {
    const tenantId = event.metadata?.tenantId;
    const retry = event.payload;
    if (!tenantId || !retry?.subscriptionId || !retry.deliveryId || !retry.body) {
      throw new Error(
        `${event.type} without a tenant, subscription or body: nothing to re-deliver`,
      );
    }
    if (!(await this.tenantStatus.isActive(tenantId))) {
      throw new Error(`The tenant ${tenantId} is not active: webhook not re-delivered`);
    }
    const sub = await this.findActiveSubscription(retry.subscriptionId, retry.eventType, tenantId);
    if (!sub) {
      throw new Error(
        `Subscription ${retry.subscriptionId} is no longer active for ${retry.eventType}: webhook not re-delivered`,
      );
    }
    const request = await this.signedRequest(sub, retry.body, retry.deliveryId, retry.eventType);
    // axios rejects a non-2xx answer, so only a delivered webhook gets past this line.
    const res = await this.post(sub.webhook.url, request);
    await this.deliveryModel
      .updateOne(
        { _id: retry.deliveryId, tenantId },
        { $set: { status: 'DELIVERED', httpStatus: res.status }, $inc: { attempts: 1 } },
      )
      .exec();
  }

  // ── Test delivery ──────────────────────────────────────────────────

  /**
   * Posts a signed `webhook.test` body (ids only, no event data) to the subscription now, whatever
   * its status, and answers how the receiver took it. Not stored as a delivery attempt, so nothing
   * is retried or dead-lettered. Redirects are not followed, like every delivery: a request that
   * reports the answer on demand must not reach a host the URL check on save never saw.
   */
  async sendTestDelivery(sub: EventSubscriptionDocument): Promise<WebhookTestResult> {
    const subscriptionId = String(sub._id);
    const deliveryId = randomUUID();
    const body = {
      eventId: randomUUID(),
      eventType: TEST_EVENT_TYPE,
      timestamp: new Date().toISOString(),
      aggregateId: subscriptionId,
      payload: {},
    };
    const sent = { subscriptionId, deliveryId, eventType: TEST_EVENT_TYPE };
    try {
      const request = await this.signedRequest(sub, body, deliveryId, TEST_EVENT_TYPE);
      const res = await this.post(sub.webhook.url, request);
      return {
        ...sent,
        success: true,
        httpStatus: res.status,
        message: `Delivered: the receiver answered ${res.status}.`,
      };
    } catch (err: unknown) {
      const httpStatus = statusOf(err);
      const error = postError(err, httpStatus, 'The test does');
      return {
        ...sent,
        success: false,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        error,
        message: `Not delivered: ${error}`,
      };
    }
  }

  // ── Delivery ───────────────────────────────────────────────────────

  private async deliverWebhook(sub: EventSubscriptionDocument, event: DomainEvent): Promise<void> {
    const lease = this.leaseFromNow();
    let attempt: DeliveryAttemptDocument;
    try {
      attempt = await this.deliveryModel.create({
        tenantId: event.metadata.tenantId,
        subscriptionId: String(sub._id),
        eventType: event.type,
        eventId: event.eventId,
        body: buildWebhookBody(event),
        status: 'PENDING',
        attempts: 0,
        // Held by this process while it sends; the retry poller takes it if the send never ends.
        nextRetryAt: lease,
      });
    } catch (err: unknown) {
      // One delivery per subscription and event (unique index): the insert is the claim. A
      // redelivered event (outbox reclaim, dead-letter replay), or one another process handles
      // at the same time, is not sent again; its first delivery retries on its own.
      if (isDuplicateKey(err)) return;
      throw err;
    }

    await this.attemptDelivery(sub, attempt, lease, attempt.attempts);
  }

  /** The end of a claim taken now. */
  private leaseFromNow(): Date {
    return new Date(Date.now() + this.leaseMs);
  }

  /**
   * JSON body and signed headers of one delivery of body. Throws, before anything is sent, for a
   * stored custom header the rules refuse (a subscription saved before they existed).
   */
  private async signedRequest(
    sub: EventSubscriptionDocument,
    body: Record<string, unknown>,
    deliveryId: string,
    eventType: string,
  ): Promise<SignedRequest> {
    const headers: Record<string, string> = {};
    for (const [name, value] of headerEntries(sub.webhook.headers)) {
      const problem = webhookHeaderNameProblem(name) ?? webhookHeaderValueProblem(value);
      if (problem) {
        throw new Error(
          `Not sent: the subscription's custom header "${name}" ${problem}. Edit the subscription's headers.`,
        );
      }
      headers[name] = value;
    }

    const json = JSON.stringify(body);
    const decryptedSecret = await this.encryptionService.decrypt(sub.webhook.signingSecret);
    const signature = createHmac('sha256', decryptedSecret).update(json).digest('hex');

    // EuroID's headers last: no custom header replaces the signature or the body's type.
    Object.assign(headers, {
      'Content-Type': 'application/json',
      'X-EuroID-Signature': `sha256=${signature}`,
      'X-EuroID-Event': eventType,
      'X-EuroID-Delivery': deliveryId,
    });
    return { json, headers };
  }

  /**
   * POSTs a signed delivery to the subscription's URL. The URL is checked again first: it may
   * have been saved before a stricter guard, and Node connects to an IP literal without the
   * agent's lookup. A host name is checked by that lookup, at connect.
   */
  private async post(url: string, request: SignedRequest): Promise<AxiosResponse> {
    try {
      checkUrlWithoutDns(url);
    } catch {
      throw new Error(`Not sent: ${WEBHOOK_URL_REFUSED}`);
    }
    return this.http.post(url, request.json, { headers: request.headers });
  }

  /**
   * One send of a delivery this process holds (PENDING, nextRetryAt = lease) that has had
   * attemptsBefore attempts. A failure is retried with backoff until the attempts run out, then
   * dead-lettered.
   */
  private async attemptDelivery(
    sub: EventSubscriptionDocument,
    attempt: DeliveryAttemptDocument,
    lease: Date,
    attemptsBefore: number,
  ): Promise<void> {
    const body = attempt.body ?? legacyWebhookBody(attempt);
    const attempts = attemptsBefore + 1;

    try {
      const request = await this.signedRequest(sub, body, String(attempt._id), attempt.eventType);
      const res = await this.post(sub.webhook.url, request);
      await this.settle(attempt, lease, {
        $set: { status: 'DELIVERED', httpStatus: res.status, attempts },
        $unset: { nextRetryAt: 1 },
      });
    } catch (err: unknown) {
      const httpStatus = statusOf(err);
      const message = postError(err, httpStatus, 'Deliveries do');
      await this.recordFailure(sub, attempt, lease, { attempts, body, message, httpStatus });
    }
  }

  /** A failed send: the next retry with backoff, or, out of attempts, the dead-letter queue. */
  private async recordFailure(
    sub: EventSubscriptionDocument,
    attempt: DeliveryAttemptDocument,
    lease: Date,
    { attempts, body, message, httpStatus }: Failure,
  ): Promise<void> {
    const failed = {
      status: 'FAILED',
      attempts,
      lastError: message,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
    };
    if (attempts < this.maxRetries) {
      const nextRetryAt = new Date(Date.now() + this.getRetryDelayMs(attempts));
      await this.settle(attempt, lease, { $set: { ...failed, nextRetryAt } });
      return;
    }
    // Out of attempts: no retry ahead. Dead-lettered once, by the process that recorded it.
    if (await this.settle(attempt, lease, { $set: failed, $unset: { nextRetryAt: 1 } })) {
      await this.captureToDeadLetter(sub, attempt, body, message, attempts);
    }
  }

  /**
   * Records the outcome of a send while this process still holds the delivery (PENDING with the
   * lease it took). False when the lease ran out and another process took the delivery over:
   * that process records its own outcome.
   */
  private async settle(
    attempt: DeliveryAttemptDocument,
    lease: Date,
    update: UpdateQuery<DeliveryAttemptDocument>,
  ): Promise<boolean> {
    const result = await this.deliveryModel
      .updateOne(
        { _id: attempt._id, tenantId: attempt.tenantId, status: 'PENDING', nextRetryAt: lease },
        update,
      )
      .exec();
    if (result.matchedCount > 0) return true;
    this.logger.warn(
      `Delivery ${String(attempt._id)}: its lease ran out before this outcome was recorded; the process that took it over records its own`,
    );
    return false;
  }

  // ── Retry poller ───────────────────────────────────────────────────

  private scheduleRetryPoll(): void {
    const intervalMs = 30_000; // Poll every 30 seconds for pending retries
    this.retryPollTimeout = setTimeout(async () => {
      try {
        await this.processRetries();
      } catch (err) {
        this.logger.error(`Delivery retry poll error: ${(err as Error).message}`);
      }
      this.scheduleRetryPoll();
    }, intervalMs);
  }

  /**
   * One poll, outside any request: tenant by tenant, in that tenant's context, the due deliveries
   * of its ACTIVE subscriptions. Deliveries of a paused or deleted subscription, or of an event
   * the subscription no longer names, are not read: they wait with their attempts unchanged.
   */
  private async processRetries(): Promise<void> {
    const now = new Date();
    const tenants = await this.subscriptionService.tenantsWithActiveSubscriptions();
    for (const tenantId of tenants) {
      try {
        // A suspended tenant's due deliveries are not claimed: they wait, attempts unchanged.
        if (!(await this.tenantStatus.isActive(tenantId))) continue;
        await withTenantContext(tenantId, () => this.retryTenant(tenantId, now));
      } catch (err) {
        this.logger.error(`Webhook retries of tenant ${tenantId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Claims the tenant's due deliveries one at a time, oldest due first, and sends each. A claim is
   * one conditional update on the state the poll looks for (FAILED with its retry due, or PENDING
   * with its lease run out), so of any number of processes polling, one takes each delivery.
   */
  private async retryTenant(tenantId: string, now: Date): Promise<void> {
    const subs = await this.subscriptionService.getActiveSubscriptions(tenantId);
    if (subs.length === 0) return;
    const deliverable = subs.map((sub) => ({
      subscriptionId: String(sub._id),
      ...eventTypeCondition(sub.filters.eventTypes),
    }));

    for (let claimed = 0; claimed < RETRY_BATCH_SIZE; claimed++) {
      const lease = this.leaseFromNow();
      // As it was before the claim: PENDING means the send that held it never finished.
      const attempt = await this.deliveryModel
        .findOneAndUpdate(
          {
            tenantId,
            status: { $in: ['FAILED', 'PENDING'] },
            nextRetryAt: { $lte: now },
            attempts: { $lt: this.maxRetries },
            $or: deliverable,
          },
          { $set: { status: 'PENDING', nextRetryAt: lease } },
          { sort: { nextRetryAt: 1, _id: 1 }, new: false },
        )
        .exec();
      if (!attempt) return;

      try {
        const sub = subs.find((s) => String(s._id) === attempt.subscriptionId);
        if (!sub) throw new Error(`subscription ${attempt.subscriptionId} is not active`);
        await this.retryClaimed(sub, attempt, lease);
      } catch (err) {
        this.logger.error(
          `Retry failed for attempt ${String(attempt._id)}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Sends a claimed delivery again. If its previous send never finished, that send counts as a
   * failed attempt first, so a delivery that stops its sender every time still runs out of
   * attempts and reaches the dead-letter queue.
   */
  private async retryClaimed(
    sub: EventSubscriptionDocument,
    attempt: DeliveryAttemptDocument,
    lease: Date,
  ): Promise<void> {
    if (attempt.status !== 'PENDING') {
      await this.attemptDelivery(sub, attempt, lease, attempt.attempts);
      return;
    }
    const attempts = attempt.attempts + 1;
    if (attempts >= this.maxRetries) {
      const body = attempt.body ?? legacyWebhookBody(attempt);
      await this.recordFailure(sub, attempt, lease, { attempts, body, message: SEND_INTERRUPTED });
      return;
    }
    if (await this.settle(attempt, lease, { $set: { attempts, lastError: SEND_INTERRUPTED } })) {
      await this.attemptDelivery(sub, attempt, lease, attempts);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Exponential backoff: 1s, 5s, 25s, 125s, 625s
   * Formula: 1000 * 5^(attemptNumber - 1)
   */
  getRetryDelayMs(attemptNumber: number): number {
    return 1000 * Math.pow(5, attemptNumber - 1);
  }

  private async findActiveSubscription(
    subscriptionId: string,
    eventType: string,
    tenantId: string,
  ): Promise<EventSubscriptionDocument | undefined> {
    const subs = await this.subscriptionService.getActiveSubscriptionsForEvent(eventType, tenantId);
    return subs.find((s) => String(s._id) === subscriptionId);
  }

  /**
   * Dead-letters a delivery that ran out of attempts as the event handleDeliveryRetry takes, so
   * a DLQ retry (automatic or by an admin) delivers it once more. The DLQ's own retry budget
   * starts at 0. The webhook URL is not stored: it can embed a token, and the retry reads the
   * subscription's current one.
   */
  private async captureToDeadLetter(
    sub: EventSubscriptionDocument,
    attempt: DeliveryAttemptDocument,
    body: Record<string, unknown>,
    error: string,
    attempts: number,
  ): Promise<void> {
    const tenantId = attempt.tenantId;
    const correlationId = getRequestContext()?.correlationId ?? randomUUID();
    const event: DomainEvent<WebhookDeliveryRetryPayload> = {
      eventId: randomUUID(),
      type: DomainEventType.WEBHOOK_DELIVERY_RETRY,
      aggregateId: String(attempt._id),
      timestamp: new Date().toISOString(),
      payload: {
        subscriptionId: String(sub._id),
        deliveryId: String(attempt._id),
        eventType: attempt.eventType,
        eventId: attempt.eventId,
        body,
      },
      metadata: {
        correlationId,
        depth: 0,
        emittedBy: EventDeliveryService.name,
        actor: 'system',
        tenantId,
      },
    };
    await this.deadLetterService.capture({
      type: 'event_handler_failure',
      source: `webhook:${String(sub._id)}:${attempt.eventType}`,
      handler: handlerKey(this, 'handleDeliveryRetry'),
      originalPayload: event as unknown as Record<string, unknown>,
      error: { message: `${error} (after ${attempts} delivery attempts)` },
      correlationId,
      tenantId,
      retryCount: 0,
    });
  }
}
