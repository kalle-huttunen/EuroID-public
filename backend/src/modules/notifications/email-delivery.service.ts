import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';
import { type MailConfig, mailConfig } from '@infrastructure/config/mail.config';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import type { EmailNotificationRetryPayload } from '@infrastructure/events/event-payloads';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import {
  EmailNotification,
  EmailNotificationDocument,
  EmailNotificationKind,
} from './schemas/email-notification.schema';
import { MailTransportService } from './mail-transport.service';
import { describeError } from './email-log';

/** A rendered notification for one recipient. */
export interface EmailMessage {
  kind: EmailNotificationKind;
  dedupeKey: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type DispatchResult = 'sent' | 'failed' | 'duplicate' | 'disabled';
export type RedeliverResult = 'sent' | 'already-sent' | 'in-progress';

type AttemptResult =
  | { outcome: 'sent' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'not-claimed' };

/**
 * A SENDING claim older than this is taken over: the process that claimed it died mid-send.
 * Six SMTP timeouts: connection, greeting, socket and DNS each, with margin.
 */
const STALE_CLAIM_TIMEOUTS = 6;

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * Stores and sends email notifications. A send never blocks or fails its caller: dispatch()
 * catches every error. A failed send is captured in the dead-letter queue as a
 * `notification.email_retry` event carrying only the stored notification's id; the DLQ's
 * auto-retry (backoff 1, 1, 5 minutes by default, DLQ_MAX_RETRIES) and its admin retry re-emit that
 * event, and EmailNotificationHandler calls redeliver(), which throws on a new failure so the
 * DLQ counts it.
 */
@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);
  private readonly staleClaimMs: number;

  constructor(
    @InjectModel(EmailNotification.name)
    private readonly model: Model<EmailNotificationDocument>,
    private readonly transport: MailTransportService,
    private readonly deadLetter: DeadLetterService,
    @Inject(mailConfig.KEY) conf: MailConfig,
  ) {
    this.staleClaimMs = conf.timeoutMs * STALE_CLAIM_TIMEOUTS;
  }

  isEnabled(): boolean {
    return this.transport.isEnabled();
  }

  /** Store and send one mail. Never throws. A dedupeKey already stored for the tenant is skipped. */
  async dispatch(tenantId: string, message: EmailMessage): Promise<DispatchResult> {
    if (!this.transport.isEnabled()) return 'disabled';
    let doc: EmailNotificationDocument;
    try {
      doc = await this.model.create({ tenantId, ...message, status: 'PENDING', attempts: 0 });
    } catch (err: unknown) {
      if (isDuplicateKey(err)) return 'duplicate';
      this.logger.error(`Email ${message.kind} not stored, not sent: ${describeError(err)}`);
      return 'failed';
    }
    let result: AttemptResult;
    try {
      result = await this.attempt(tenantId, doc._id);
    } catch (err: unknown) {
      // Claim or status write failed (database): leave it to the dead-letter retry.
      result = { outcome: 'failed', error: describeError(err) };
    }
    if (result.outcome === 'sent') return 'sent';
    if (result.outcome === 'failed') {
      this.logger.warn(`Email ${message.kind} ${String(doc._id)} not sent: ${result.error}`);
      await this.captureForRetry(tenantId, String(doc._id), message.kind, result.error);
    }
    return 'failed';
  }

  /**
   * Retry one stored notification (dead-letter retry). Throws when it cannot be sent, so the
   * dead-letter entry records the failed attempt and backs off.
   */
  async redeliver(tenantId: string, notificationId: string): Promise<RedeliverResult> {
    if (!Types.ObjectId.isValid(notificationId)) {
      throw new Error(`Email notification id ${notificationId} is not valid`);
    }
    const doc = await this.model.findOne({ _id: notificationId, tenantId }).lean().exec();
    if (!doc) throw new Error(`Email notification ${notificationId} no longer exists`);
    if (doc.status === 'SENT') return 'already-sent';
    if (!this.transport.isEnabled()) {
      throw new Error(`Email notification ${notificationId} not sent: SMTP_HOST is not set`);
    }
    const result = await this.attempt(tenantId, doc._id);
    if (result.outcome === 'failed') {
      throw new Error(`Email notification ${notificationId} not sent: ${result.error}`);
    }
    return result.outcome === 'sent' ? 'sent' : 'in-progress';
  }

  /** Claim the notification (no other process sending it), send it, record the outcome. */
  private async attempt(tenantId: string, id: Types.ObjectId): Promise<AttemptResult> {
    const now = new Date();
    const claimed = await this.model
      .findOneAndUpdate(
        {
          _id: id,
          tenantId,
          $or: [
            { status: { $in: ['PENDING', 'FAILED'] } },
            { status: 'SENDING', claimedAt: { $lt: new Date(now.getTime() - this.staleClaimMs) } },
          ],
        },
        { $set: { status: 'SENDING', claimedAt: now }, $inc: { attempts: 1 } },
        { new: true },
      )
      .lean()
      .exec();
    if (!claimed) return { outcome: 'not-claimed' };

    try {
      await this.transport.send({
        to: claimed.to,
        subject: claimed.subject,
        text: claimed.text ?? '',
        html: claimed.html ?? '',
      });
    } catch (err: unknown) {
      const error = describeError(err);
      await this.model
        .updateOne({ _id: id, tenantId }, { $set: { status: 'FAILED', lastError: error } })
        .exec();
      return { outcome: 'failed', error };
    }
    await this.model
      .updateOne(
        { _id: id, tenantId },
        {
          $set: { status: 'SENT', sentAt: new Date() },
          $unset: { text: '', html: '', lastError: '' },
        },
      )
      .exec();
    return { outcome: 'sent' };
  }

  private async captureForRetry(
    tenantId: string,
    notificationId: string,
    kind: EmailNotificationKind,
    error: string,
  ): Promise<void> {
    const correlationId = getRequestContext()?.correlationId ?? randomUUID();
    const event: DomainEvent<EmailNotificationRetryPayload> = {
      eventId: randomUUID(),
      type: DomainEventType.EMAIL_NOTIFICATION_RETRY,
      aggregateId: notificationId,
      timestamp: new Date().toISOString(),
      payload: { notificationId, kind },
      metadata: {
        correlationId,
        depth: 0,
        emittedBy: EmailDeliveryService.name,
        actor: 'system',
        tenantId,
      },
    };
    // In the entry's tenant whatever the caller's context: the tenant plugin also validates the
    // entry's nested `error` document, and without a context capture fails (and only logs).
    await withTenantContext(tenantId, () =>
      this.deadLetter.capture({
        type: 'event_handler_failure',
        source: `email:${kind}`,
        originalPayload: event as unknown as Record<string, unknown>,
        error: { message: error },
        correlationId,
        retryCount: 0,
        tenantId,
      }),
    );
  }
}
