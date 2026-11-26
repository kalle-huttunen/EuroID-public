import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { OutboxEvent, OutboxEventDocument } from './schemas/outbox-event.schema';
import { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';
import { DomainEvent } from './domain-event.interface';
import { failedHandlerOf } from './handler-dispatch';

const MAX_RETRIES = 5;
const TTL_DAYS = 7;
const MAX_POLL_INTERVAL_MS = 60_000;
/** Defaults of OUTBOX_CLAIM_TIMEOUT_MS, OUTBOX_SWEEP_INTERVAL_MS, OUTBOX_RETRY_BASE_MS (events.config.ts). */
const DEFAULT_CLAIM_TIMEOUT_MS = 300_000;
const DEFAULT_SWEEP_INTERVAL_MS = 15_000;
const DEFAULT_RETRY_BASE_MS = 5_000;

/**
 * Polls the event_outbox collection and publishes pending events to the in-process event bus.
 * Uses Change Streams when MongoDB is a replica set; falls back to polling on standalone. With
 * change streams it also sweeps every OUTBOX_SWEEP_INTERVAL_MS, so a stale claim or a retry that
 * fell due is taken without waiting for a later change. Exponential backoff on consecutive poll
 * errors to avoid retry storms.
 *
 * A claim is a lease: the process renews claimedAt while its handlers run, and writes the outcome
 * only while it still holds the claim (claimToken). A claim older than OUTBOX_CLAIM_TIMEOUT_MS
 * (its process stopped) is taken again, so the event is delivered again (at least once) instead
 * of never, and a slow handler no longer lets another process publish it a second time. A failed
 * publish is retried after OUTBOX_RETRY_BASE_MS, doubling per failure (nextAttemptAt), and goes
 * to the dead letter queue after MAX_RETRIES.
 */
@Injectable()
export class OutboxPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPollerService.name);
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;
  private changeStream: { close: () => Promise<void> } | null = null;
  private useChangeStreams = false;
  private consecutiveErrorCount = 0;
  private destroyed = false;

  constructor(
    @InjectModel(OutboxEvent.name) private readonly outboxModel: Model<OutboxEventDocument>,
    private readonly emitter: EventEmitter2,
    private readonly deadLetterService: DeadLetterService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const stream = this.outboxModel.watch([], { fullDocument: 'updateLookup' });
    this.changeStream = stream;

    stream.on('change', () => {
      this.processPending().catch((err) =>
        this.logger.error(`Outbox process on change: ${err.message}`, err.stack),
      );
    });

    stream.on('error', async (err: unknown) => {
      if (!this.useChangeStreams) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('replica set') ||
        msg.includes('Transaction numbers') ||
        msg.includes('change streams') ||
        (err as Record<string, unknown>)?.code === 40573
      ) {
        this.logger.warn(
          'Change Streams unavailable (standalone MongoDB), falling back to polling',
        );
      } else {
        this.logger.error(
          `Outbox change stream error: ${msg}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
      if (this.changeStream) {
        await this.changeStream.close();
        this.changeStream = null;
      }
      this.useChangeStreams = false;
      this.startPolling();
    });

    this.useChangeStreams = true;
    this.logger.log(
      'Outbox poller: using Change Streams (will fall back to polling if standalone)',
    );

    await this.processPending();
    // The stream only signals changes: the sweep takes stale claims and retries that fell due.
    this.scheduleNextPoll();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    if (this.changeStream) {
      await this.changeStream.close();
      this.changeStream = null;
    }
  }

  private startPolling(): void {
    if (this.pollTimeout) clearTimeout(this.pollTimeout);
    this.scheduleNextPoll();
  }

  /** The next poll (polling mode) or sweep (change streams), later after consecutive errors. */
  private scheduleNextPoll(): void {
    if (this.destroyed) return;
    const baseInterval = this.useChangeStreams
      ? (this.config.get<number>('events.OUTBOX_SWEEP_INTERVAL_MS') ?? DEFAULT_SWEEP_INTERVAL_MS)
      : (this.config.get<number>('events.OUTBOX_POLL_INTERVAL_MS') ?? 2000);
    const delay = Math.min(
      baseInterval * Math.pow(2, this.consecutiveErrorCount),
      MAX_POLL_INTERVAL_MS,
    );
    this.pollTimeout = setTimeout(() => {
      this.processPending()
        .then(() => {
          this.consecutiveErrorCount = 0;
        })
        .catch((err) => {
          this.consecutiveErrorCount++;
          this.logger.error(
            `Outbox poll error: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err.stack : undefined,
          );
        })
        .finally(() => {
          this.scheduleNextPoll();
        });
    }, delay);
  }

  async processPending(): Promise<void> {
    const batchSize = this.config.get<number>('events.OUTBOX_POLLER_BATCH_SIZE') ?? 100;
    const claimTimeoutMs =
      this.config.get<number>('events.OUTBOX_CLAIM_TIMEOUT_MS') ?? DEFAULT_CLAIM_TIMEOUT_MS;
    let processed = 0;

    while (processed < batchSize) {
      // Atomic claim: findOneAndUpdate ensures only one pod processes each event. A claim older
      // than the timeout is taken again: the process that held it stopped before it published.
      const now = new Date();
      const staleBefore = new Date(now.getTime() - claimTimeoutMs);
      const claimToken = randomUUID();
      const doc = await this.outboxModel
        .findOneAndUpdate(
          {
            $or: [
              // A failed event waits for its retry time (nextAttemptAt)
              {
                status: 'pending',
                $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
              },
              { status: 'processing', claimedAt: { $lt: staleBefore } },
              // Claimed while the schema had no claimedAt (Mongoose dropped it): the claim's
              // updatedAt is when it was taken
              { status: 'processing', claimedAt: null, updatedAt: { $lt: staleBefore } },
            ],
          },
          { $set: { status: 'processing', claimedAt: now, claimToken } },
          { sort: { createdAt: 1 }, new: true },
        )
        .setOptions({ skipTenantScope: true })
        .lean()
        .exec();

      if (!doc) break; // No more pending events
      await this.publishOne(doc as OutboxEventDocument, claimToken, claimTimeoutMs);
      processed++;
    }
  }

  /** Renew the claim (claimedAt) every third of the timeout while the handlers run. */
  private renewClaim(
    id: OutboxEventDocument['_id'],
    claimToken: string,
    claimTimeoutMs: number,
  ): NodeJS.Timeout {
    const timer = setInterval(
      () => {
        this.outboxModel
          .updateOne(
            { _id: id, claimToken, status: 'processing' },
            { $set: { claimedAt: new Date() } },
          )
          .setOptions({ skipTenantScope: true })
          .exec()
          .catch((err: unknown) =>
            this.logger.warn(
              `Outbox claim renewal failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      },
      Math.max(100, Math.floor(claimTimeoutMs / 3)),
    );
    timer.unref();
    return timer;
  }

  private async publishOne(
    doc: OutboxEventDocument & { _id?: unknown; createdAt?: Date },
    claimToken: string,
    claimTimeoutMs: number,
  ): Promise<void> {
    // Outcomes are written only while this process holds the claim.
    const ours = { _id: doc._id, claimToken };
    const event: DomainEvent = {
      eventId: doc.eventId,
      type: doc.type as DomainEvent['type'],
      aggregateId: doc.aggregateId,
      timestamp: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
      payload: doc.payload,
      metadata: doc.metadata,
    };

    const renewal = this.renewClaim(doc._id, claimToken, claimTimeoutMs);
    try {
      try {
        await this.emitter.emitAsync(doc.type, event);
      } finally {
        clearInterval(renewal);
      }

      const expireAt = new Date();
      expireAt.setDate(expireAt.getDate() + TTL_DAYS);

      await this.outboxModel
        .updateOne(ours, {
          $set: {
            status: 'published',
            publishedAt: new Date(),
            expireAt,
          },
        })
        .setOptions({ skipTenantScope: true })
        .exec();

      this.logger.debug(`Published outbox event ${doc.eventId} (${doc.type})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryCount = (doc.retryCount ?? 0) + 1;

      if (retryCount >= MAX_RETRIES) {
        await this.outboxModel
          .updateOne(ours, { $set: { status: 'failed' }, $inc: { retryCount: 1 } })
          .setOptions({ skipTenantScope: true })
          .exec();

        this.deadLetterService.capture({
          type: 'event_handler_failure',
          source: doc.type,
          // Only a `suppressErrors: false` listener rejects the emit; retry runs it alone.
          handler: failedHandlerOf(err),
          originalPayload: event as unknown as Record<string, unknown>,
          error: {
            message: `Outbox publish failed after ${MAX_RETRIES} retries: ${msg}`,
            stack: err instanceof Error ? err.stack : undefined,
          },
          correlationId: doc.metadata?.correlationId,
          retryCount: MAX_RETRIES,
          tenantId: doc.metadata?.tenantId,
        });

        this.logger.error(`Outbox event ${doc.eventId} failed after ${MAX_RETRIES} retries → DLQ`);
      } else {
        // Back to pending, claimed again once nextAttemptAt is reached: base, 2x, 4x, 8x.
        const retryBaseMs =
          this.config.get<number>('events.OUTBOX_RETRY_BASE_MS') ?? DEFAULT_RETRY_BASE_MS;
        const delayMs = retryBaseMs * 2 ** (retryCount - 1);
        const nextAttemptAt = new Date(Date.now() + delayMs);
        await this.outboxModel
          .updateOne(ours, { $set: { status: 'pending', nextAttemptAt }, $inc: { retryCount: 1 } })
          .setOptions({ skipTenantScope: true })
          .exec();

        this.logger.warn(
          `Outbox event ${doc.eventId} failed (retry ${retryCount}/${MAX_RETRIES} in ${delayMs} ms): ${msg}`,
        );
      }
    }
  }
}

// ── TASK 106 RECAP ──
// Added: Outbox poller service. Uses Change Streams when replica set; else 2s polling. Queries pending
// events, publishes via emitAsync, marks published (sets expireAt for TTL) or retries; after 5 retries → DLQ.
