/**
 * Dead Letter Queue Service
 *
 * Captures failed events, workflows, and connector errors. Never throws — DLQ
 * write failures are logged and ignored so the system stays up.
 *
 * Retry and replay re-run an entry (see dead-letter-rerun.ts: the failed handler alone, or the
 * event re-emitted to every handler) and close it as `replayed` only when that re-run succeeded.
 * An entry without a domain event is refused with 409. Auto-retry polls for the entries this
 * process can re-run, with exponential backoff; after maxRetries: failed_permanently.
 * Every re-run starts with a claim (dead-letter-claim.ts), so one process re-runs an entry at a
 * time; one already being re-run is refused with 409.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  OnModuleInit,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, UpdateQuery } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import {
  DeadLetterEntry,
  DeadLetterEntryDocument,
  DeadLetterStatus,
  DeadLetterType,
} from './schemas/dead-letter.schema';
import { DomainEventType } from '@infrastructure/events/event-types';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { isSecretByName } from '@infrastructure/secrets/config-secret-mask';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { escapeRegex } from '@shared/utils/escape-regex';
import { maskPiiAndPhonesDeep } from '../identity/identity-pii';
import { maskEmails } from '../../activities/deprovision-failure';
import { DeadLetterHandlerRegistry } from './dead-letter-handler.registry';
import { planRerun, rerunnableFilter } from './dead-letter-rerun';
import {
  claimEntry,
  RETRY_INTERRUPTED,
  RetryInProgressException,
  settleClaim,
} from './dead-letter-claim';

// ── DTOs ────────────────────────────────────────────────────────────

export interface CaptureDto {
  type: DeadLetterType;
  source: string;
  originalPayload: Record<string, unknown>;
  error: { message: string; stack?: string; code?: string };
  correlationId?: string;
  retryCount?: number;
  /** Required for tenant isolation. Extract from originalPayload.metadata?.tenantId when available. */
  tenantId?: string;
  /** The `@OnEvent` handler that failed (`Class.method`); retry then runs only this handler. */
  handler?: string;
}

/** What a retry or replay did to an entry (the response of POST /:id/retry and /:id/replay). */
export interface DeadLetterRunOutcome {
  id: string;
  /** `replayed` when the re-run succeeded; else `pending` or, at the limit, `failed_permanently`. */
  status: DeadLetterStatus;
  retryCount: number;
  maxRetries: number;
  /** Why the re-run failed, email addresses masked like the entry's other error texts. */
  error?: string;
}

export interface DeadLetterFilter {
  type?: DeadLetterType;
  status?: DeadLetterStatus;
  /** Case-insensitive prefix of the entry's source. */
  source?: string;
  limit?: number;
  offset?: number;
}

/**
 * Copy of obj with secret keys replaced, at any depth. Entries that belong to no registered
 * connector (event handler failures, event chain and validation failures, workflow terminals,
 * webhook deliveries) carry domain events or workflow inputs, which no connector manifest
 * describes, so they are redacted by key name (isSecretByName).
 */
function redactSecrets(
  obj: Record<string, unknown>,
  isSecret: (key: string) => boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSecret(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = redactSecrets(v as Record<string, unknown>, isSecret);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Copy of node with every email address in a string masked (m•••@example.com, identity-pii's
 * maskEmail), at any depth. Dead-letter responses must not carry an address: event payloads hold
 * the identity's email, UPN or mail, and errors can quote one.
 */
function maskEmailsDeep(node: unknown): unknown {
  if (typeof node === 'string') return maskEmails(node);
  if (Array.isArray(node)) return node.map(maskEmailsDeep);
  if (node === null || typeof node !== 'object') return node;
  const proto: unknown = Object.getPrototypeOf(node);
  if (proto !== Object.prototype && proto !== null) return node; // Date, ObjectId, Buffer
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = maskEmailsDeep(v);
  return out;
}

// ── Service ──────────────────────────────────────────────────────────

/** The statuses an operator can dismiss an entry from: it is still open. */
const DISMISSABLE: DeadLetterStatus[] = ['pending', 'retrying', 'failed_permanently'];

@Injectable()
export class DeadLetterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeadLetterService.name);
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @InjectModel(DeadLetterEntry.name)
    private readonly model: Model<DeadLetterEntryDocument>,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly pluginRegistry: PluginRegistryService,
    // Optional: a context without the events infrastructure has no per-handler re-runs.
    @Optional() private readonly handlers?: DeadLetterHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.scheduleRetryPoll();
  }

  onModuleDestroy(): void {
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  // ── Capture ────────────────────────────────────────────────────────

  /**
   * Capture a failed event/workflow/connector error. Fire-and-forget — never throws.
   * tenantId: pass explicitly or extract from originalPayload.metadata?.tenantId.
   */
  async capture(entry: CaptureDto): Promise<void> {
    // An empty tenantId (an event emitted without one) falls through to the next source.
    const tenantId =
      entry.tenantId ||
      (entry.originalPayload?.metadata as { tenantId?: string } | undefined)?.tenantId ||
      getRequestContext()?.tenantId ||
      'no-tenant';
    const maxRetries = this.configService.get<number>('deadLetter.DLQ_MAX_RETRIES') ?? 3;
    try {
      await this.model.create({
        tenantId,
        type: entry.type,
        source: entry.source,
        originalPayload: entry.originalPayload,
        ...(entry.handler ? { handler: entry.handler } : {}),
        error: entry.error,
        correlationId: entry.correlationId,
        retryCount: entry.retryCount ?? 0,
        maxRetries,
        nextRetryAt: new Date(Date.now() + 60_000), // First auto-retry after 1 minute
        status: 'pending',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`DLQ capture failed: ${message}`, stack);
    }
  }

  // ── Query ──────────────────────────────────────────────────────────

  /**
   * List entries with optional filters and pagination.
   */
  async findAll(filter?: DeadLetterFilter): Promise<DeadLetterEntryDocument[]> {
    const query: Record<string, unknown> = {};
    if (filter?.type) query.type = filter.type;
    if (filter?.status) query.status = filter.status;
    if (filter?.source) query.source = { $regex: '^' + escapeRegex(filter.source), $options: 'i' };

    const limit = Math.min(filter?.limit ?? 50, 100);
    const offset = filter?.offset ?? 0;

    const docs = (await this.model
      .find(query)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean()
      .exec()) as DeadLetterEntryDocument[];
    return docs.map((d) => this.sanitizeForResponse(d));
  }

  /**
   * Get a single entry by ID. Sanitizes response: strips error.stack in production,
   * redacts secret originalPayload fields (DLQ-2) and masks personal data (see sanitizeForResponse).
   */
  async findOne(id: string): Promise<DeadLetterEntryDocument> {
    const doc = await this.model.findById(id).lean().exec();
    if (!doc) {
      throw new NotFoundException(`Dead letter entry ${id} not found`);
    }
    return this.sanitizeForResponse(doc as DeadLetterEntryDocument);
  }

  private sanitizeForResponse(doc: DeadLetterEntryDocument): DeadLetterEntryDocument {
    const isProd = process.env.NODE_ENV === 'production';
    const sanitized = { ...doc } as DeadLetterEntryDocument;
    // Personal data is masked in the response only: the stored entry keeps the clear event, so
    // retry and replay re-emit what the handler originally received.
    const maskText = (text?: string) => (typeof text === 'string' ? maskEmails(text) : text);
    if (sanitized.error) {
      sanitized.error = {
        message: maskText(sanitized.error.message) as string,
        code: sanitized.error.code,
        ...(isProd ? {} : { stack: maskText(sanitized.error.stack) }),
      };
    }
    if (sanitized.lastRetryError) sanitized.lastRetryError = maskText(sanitized.lastRetryError);
    if (sanitized.originalPayload && typeof sanitized.originalPayload === 'object') {
      // An entry whose source is a registered connector is redacted by that connector's
      // declared secrets (type: 'password'), like GET /connectors; anything else by key name.
      const declared = this.pluginRegistry.getSecretConfigKeys(sanitized.source);
      const redacted = redactSecrets(
        sanitized.originalPayload as Record<string, unknown>,
        declared ? (key) => declared.has(key) : isSecretByName,
      );
      // identity-pii: PII_FIELDS masked like identity responses, every phone-like field (phone,
      // telephoneNumber, businessPhones, ...) like mobilePhone, and every email address.
      sanitized.originalPayload = maskEmailsDeep(maskPiiAndPhonesDeep(redacted)) as Record<
        string,
        unknown
      >;
    }
    return sanitized;
  }

  // ── Dismiss & Replay (existing) ────────────────────────────────────

  /**
   * Mark an entry as dismissed.
   */
  /**
   * Dismiss an open entry (DISMISSABLE), recording who and when; a closed one is 409 and keeps who
   * closed it, an unknown one 404. Of a dismiss and a replay at once, one closes the entry.
   */
  async dismiss(id: string, actor: string): Promise<void> {
    const result = await this.model
      .findOneAndUpdate(
        { _id: id, status: { $in: DISMISSABLE } },
        { $set: { status: 'dismissed', resolvedBy: actor, resolvedAt: new Date() } },
      )
      .exec();
    if (result) return;

    const current = await this.model.findById(id).select('status').lean().exec();
    if (!current) throw new NotFoundException(`Dead letter entry ${id} not found`);
    throw new ConflictException(
      `Dead letter entry ${id} is ${current.status}: only an open entry can be dismissed`,
    );
  }

  /**
   * Replay a pending entry now and wait for it: closes it as replayed when the re-run succeeded.
   * A failure leaves it pending as it was, with the error: unlike retry, it does not count as an
   * attempt. Throws ConflictException when the entry has nothing to re-run or is being re-run.
   */
  async replay(id: string, actor: string): Promise<DeadLetterRunOutcome> {
    const doc = await this.model.findById(id).exec();
    if (!doc) {
      throw new NotFoundException(`Dead letter entry ${id} not found`);
    }

    if (doc.status !== 'pending') {
      throw new BadRequestException(`Entry ${id} is not in a replayable state`);
    }

    const rerun = planRerun(id, doc, this.eventEmitter, this.handlers);
    const maxRetries = doc.maxRetries ?? 3;
    const lease = await claimEntry(this.model, id, doc, this.leaseMs());
    try {
      await rerun();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Replay of dead-letter entry ${id} failed: ${message}`);
      // Back to its automatic retry time (capture always sets one).
      await this.settle(id, lease, {
        $set: { status: 'pending', nextRetryAt: doc.nextRetryAt, lastRetryError: message },
      });
      return {
        id,
        status: 'pending',
        retryCount: doc.retryCount,
        maxRetries,
        error: maskEmails(message),
      };
    }

    await this.settle(id, lease, {
      $set: { status: 'replayed', resolvedBy: actor, resolvedAt: new Date() },
      $unset: { nextRetryAt: 1 },
    });
    return { id, status: 'replayed', retryCount: doc.retryCount, maxRetries };
  }

  // ── Retry (F-19) ──────────────────────────────────────────────────

  /**
   * Retry a single DLQ entry: re-runs it (dead-letter-rerun.ts) and waits for the outcome.
   * Success: replayed, emits DLQ_ENTRY_RETRIED. Failure: increments retryCount, sets nextRetryAt
   * with exponential backoff; at maxRetries: failed_permanently, emits DLQ_ENTRY_FAILED_PERMANENTLY.
   * Throws ConflictException, before touching the entry, when it has nothing to re-run or another
   * process or admin is re-running it. dueBy (the automatic retry): the entry is taken only while
   * its retry is due at that time, so one another process retried meanwhile waits for its next.
   */
  async retryEntry(id: string, actor: string, dueBy?: Date): Promise<DeadLetterRunOutcome> {
    const doc = await this.model.findById(id).exec();
    if (!doc) {
      throw new NotFoundException(`Dead letter entry ${id} not found`);
    }

    const terminalStatuses: DeadLetterStatus[] = ['replayed', 'dismissed', 'failed_permanently'];
    if (terminalStatuses.includes(doc.status)) {
      throw new BadRequestException(
        `Entry ${id} is not in a retryable state (status: ${doc.status})`,
      );
    }

    const rerun = planRerun(id, doc, this.eventEmitter, this.handlers);
    const maxRetries = doc.maxRetries ?? 3;
    const lease = await claimEntry(this.model, id, doc, this.leaseMs(), dueBy);

    let retryCount = doc.retryCount;
    if (doc.status === 'retrying') {
      // The re-run that held it before never finished: it counts as a failed retry.
      retryCount += 1;
      if (retryCount >= maxRetries) {
        return this.recordRetryFailure(doc, lease, retryCount, RETRY_INTERRUPTED, actor);
      }
      await this.settle(id, lease, { $set: { retryCount, lastRetryError: RETRY_INTERRUPTED } });
    }

    try {
      await rerun();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return this.recordRetryFailure(doc, lease, retryCount + 1, message, actor);
    }

    // The re-run succeeded: closed as replayed, announced by the process that closed it.
    const closed = await this.settle(id, lease, {
      $set: { status: 'replayed', resolvedBy: actor, resolvedAt: new Date() },
      $unset: { nextRetryAt: 1 },
    });
    if (closed) {
      // Emit retry success event (via EventEmitter2 directly, which avoids a circular dep)
      this.emitDlqEvent(
        DomainEventType.DLQ_ENTRY_RETRIED,
        id,
        { entryId: id, type: doc.type, source: doc.source, retryCount },
        doc.tenantId,
        actor,
      );
    }
    return { id, status: 'replayed', retryCount, maxRetries };
  }

  /** A failed re-run of a claimed entry: the next retry with backoff, or failed_permanently. */
  private async recordRetryFailure(
    doc: DeadLetterEntryDocument,
    lease: Date,
    newRetryCount: number,
    message: string,
    actor: string,
  ): Promise<DeadLetterRunOutcome> {
    const id = String(doc._id);
    const maxRetries = doc.maxRetries ?? 3;
    const outcome = { id, retryCount: newRetryCount, maxRetries, error: maskEmails(message) };

    if (newRetryCount >= maxRetries) {
      const closed = await this.settle(id, lease, {
        $set: { status: 'failed_permanently', retryCount: newRetryCount, lastRetryError: message },
        $unset: { nextRetryAt: 1 },
      });
      if (closed) {
        this.emitDlqEvent(
          DomainEventType.DLQ_ENTRY_FAILED_PERMANENTLY,
          id,
          {
            entryId: id,
            type: doc.type,
            source: doc.source,
            retryCount: newRetryCount,
            error: message,
          },
          doc.tenantId,
          actor,
        );
      }
      return { ...outcome, status: 'failed_permanently' };
    }

    await this.settle(id, lease, {
      $set: {
        status: 'pending',
        retryCount: newRetryCount,
        nextRetryAt: new Date(Date.now() + this.getRetryDelayMs(newRetryCount)),
        lastRetryError: message,
      },
    });
    return { ...outcome, status: 'pending' };
  }

  /**
   * Batch retry: retry the re-runnable entries matching a filter (max 100 per call).
   * processed: entries re-run; replayed: of those, closed as replayed (the rest failed again);
   * failed: entries that could not be retried at all (state changed, refused, error).
   */
  async batchRetry(
    filter: { type?: DeadLetterType },
    actor: string,
  ): Promise<{ processed: number; replayed: number; failed: number }> {
    // Only a handler failure that kept its event can be re-run.
    if (filter.type && filter.type !== 'event_handler_failure') {
      return { processed: 0, replayed: 0, failed: 0 };
    }
    const query: Record<string, unknown> = {
      status: { $in: ['pending', 'retrying'] },
      ...rerunnableFilter(this.handlers?.keys() ?? []),
    };

    const entries = await this.model.find(query).limit(100).exec();
    let processed = 0;
    let replayed = 0;
    let failed = 0;

    for (const entry of entries) {
      try {
        const outcome = await this.retryEntry(String(entry._id), actor);
        processed++;
        if (outcome.status === 'replayed') replayed++;
      } catch {
        failed++;
      }
    }
    return { processed, replayed, failed };
  }

  /**
   * Get DLQ statistics by status.
   */
  async getStats(): Promise<Record<string, number>> {
    const pipeline = [{ $group: { _id: '$status', count: { $sum: 1 } } }];
    const results = await this.model.aggregate(pipeline).exec();
    const stats: Record<string, number> = {};
    for (const r of results) {
      stats[r._id as string] = r.count as number;
    }
    return stats;
  }

  // ── Auto-Retry Poller ──────────────────────────────────────────────

  private scheduleRetryPoll(): void {
    const intervalMs =
      this.configService.get<number>('deadLetter.DLQ_RETRY_POLL_INTERVAL_MS') ?? 60_000;
    this.pollTimeout = setTimeout(async () => {
      try {
        await this.processAutoRetries();
      } catch (err) {
        this.logger.error(`DLQ auto-retry poll error: ${(err as Error).message}`);
      }
      this.scheduleRetryPoll();
    }, intervalMs);
  }

  /**
   * Process up to 50 entries eligible for auto-retry, the longest due first: status pending with
   * nextRetryAt <= now, or retrying with its lease (nextRetryAt) run out; retryCount < maxRetries.
   * Each is re-run only if this process claims it; one another process took is skipped.
   */
  async processAutoRetries(): Promise<number> {
    const now = new Date();
    const entries = await this.model
      .find({
        status: { $in: ['pending', 'retrying'] },
        nextRetryAt: { $lte: now },
        $expr: { $lt: ['$retryCount', '$maxRetries'] },
        // Only an entry retryEntry can re-run: a handler failure with its event, whose handler
        // (if named) is registered here. retryEntry refuses any other (workflow terminal,
        // connector error), so those wait for an admin and never crowd out the 50 picked.
        ...rerunnableFilter(this.handlers?.keys() ?? []),
      })
      .sort({ nextRetryAt: 1, _id: 1 })
      .setOptions({ skipTenantScope: true })
      .limit(50)
      .exec();

    let processed = 0;
    for (const entry of entries) {
      try {
        // The poller runs outside any request: retry in the entry's tenant, which retryEntry's
        // tenant-scoped lookups and the handlers it re-emits to need.
        await withTenantContext(entry.tenantId, () =>
          this.retryEntry(String(entry._id), 'auto-retry-poller', now),
        );
        processed++;
      } catch (err) {
        if (err instanceof RetryInProgressException) continue; // another process has it
        this.logger.warn(
          `Auto-retry failed for entry ${String(entry._id)}: ${(err as Error).message}`,
        );
      }
    }
    return processed;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Exponential backoff for DLQ retries: 1min, 5min, 25min.
   * Formula: 60000 * 5^(retryCount - 1)
   */
  getRetryDelayMs(retryCount: number): number {
    return 60_000 * Math.pow(5, retryCount - 1);
  }

  /** How long a claim to re-run an entry lasts (dead-letter-claim.ts). */
  private leaseMs(): number {
    return this.configService.get<number>('deadLetter.DLQ_RETRY_LEASE_MS') ?? 300_000;
  }

  /** Writes a re-run's outcome while its claim holds; logs and answers false once it is lost. */
  private async settle(
    id: string,
    lease: Date,
    update: UpdateQuery<DeadLetterEntryDocument>,
  ): Promise<boolean> {
    if (await settleClaim(this.model, id, lease, update)) return true;
    this.logger.warn(
      `Dead-letter entry ${id} changed while it was re-run (dismissed, or its lease ran out and another process took it over): this outcome is not recorded`,
    );
    return false;
  }

  /**
   * Emit DLQ-related events directly via EventEmitter2 (not DomainEventEmitterService)
   * to avoid circular dependency.
   */
  private emitDlqEvent(
    type: DomainEventType,
    aggregateId: string,
    payload: Record<string, unknown>,
    tenantId: string,
    actor: string,
  ): void {
    this.eventEmitter
      .emitAsync(type, {
        eventId: randomUUID(),
        type,
        aggregateId,
        timestamp: new Date().toISOString(),
        payload,
        metadata: {
          correlationId: randomUUID(),
          depth: 0,
          emittedBy: 'DeadLetterService',
          actor,
          tenantId,
        },
      })
      .catch((err) => {
        this.logger.error(`Failed to emit ${type}: ${(err as Error).message}`);
      });
  }
}
