/**
 * Appends audit events to their tenant's hash chain, one chain per tenant whatever the number of
 * writing processes (the API, the worker, concurrent requests in one process).
 *
 * Each event takes the next position after the tenant's chain head (`seq`) and links to the head's
 * hash. Storing the event is the atomic step: the unique `{ tenantId, seq }` index lets one of two
 * writers that took the same position store its event; the other catches the head up from the
 * stored events and takes the next position. The head moves forward after the event is stored and
 * never back, so a writer that stopped between the two steps leaves no gap: the next writer meets
 * the stored event and catches the head up. A write that fails (a redelivered domain event refused
 * by the eventId index, a validation error) stores nothing and leaves the head where it was.
 * Within one process a tenant's writes run one after another, so a burst (a bulk operation, the
 * outbox poller) does not race for the head: only other processes contend for a position.
 */
import { Logger } from '@nestjs/common';
import type { Model, ToObjectOptions } from 'mongoose';
import type { AuditEventDocument } from './schemas/audit-event.schema';
import type { AuditChainHead, AuditChainHeadDocument } from './schemas/audit-chain-head.schema';
import { AUDIT_HASH_VERSION, GENESIS_HASH, auditEventHash } from './audit-hash';

/** Attempts per write when other writers keep taking the next position first. */
const WRITE_ATTEMPTS = parseInt(process.env.AUDIT_CHAIN_WRITE_ATTEMPTS ?? '50', 10);

/** The document as Mongoose inserts it (Model.prototype.save uses these options, minimize on). */
const STORED_FORM: ToObjectOptions = {
  transform: false,
  virtuals: false,
  getters: false,
  depopulate: true,
  versionKey: false,
};

/**
 * Filter on chain positions. `$type: 'number'` matches the partial `{ tenantId, seq }` index's
 * filter, so MongoDB can use the index; Mongoose's query types do not list the alias.
 */
export const chainPosition = (range: Record<string, number> = {}): Record<string, unknown> => ({
  $type: 'number',
  ...range,
});

/** A write refused by a unique index (MongoDB duplicate key). */
export const isDuplicateKey = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

/** Refused by the `{ tenantId, seq }` index: another writer stored an event at this position. */
const isPositionTaken = (err: unknown) => {
  if (!isDuplicateKey(err)) return false;
  const { keyPattern, message } = err as { keyPattern?: Record<string, unknown>; message?: string };
  return keyPattern ? 'seq' in keyPattern : /seq_1/.test(message ?? '');
};

type HeadPosition = Pick<AuditChainHead, 'seq' | 'lastHash'>;

export class AuditChainWriter {
  private readonly logger = new Logger(AuditChainWriter.name);
  /** Per tenant, the end of this process's queue of writes. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly events: Model<AuditEventDocument>,
    private readonly heads: Model<AuditChainHeadDocument>,
  ) {}

  /** Stores the event at the next position of its tenant's chain; `timestamp` is set here. */
  append(entry: Record<string, unknown> & { tenantId: string }): Promise<AuditEventDocument> {
    const { tenantId } = entry;
    const write = (this.queues.get(tenantId) ?? Promise.resolve()).then(() => this.store(entry));
    const done = write.catch(() => undefined);
    this.queues.set(tenantId, done);
    void done.then(() => {
      if (this.queues.get(tenantId) === done) this.queues.delete(tenantId);
    });
    return write;
  }

  private async store(
    entry: Record<string, unknown> & { tenantId: string },
  ): Promise<AuditEventDocument> {
    const { tenantId } = entry;
    for (let attempt = 1; ; attempt++) {
      const head = await this.headOf(tenantId);
      const doc = new this.events({
        ...entry,
        timestamp: new Date(),
        seq: head.seq + 1,
        previousHash: head.lastHash,
        hashVersion: AUDIT_HASH_VERSION,
      });
      doc.integrityHash = auditEventHash(
        doc.toObject(STORED_FORM) as unknown as Record<string, unknown>,
      );
      try {
        await doc.save();
      } catch (err: unknown) {
        if (!isPositionTaken(err) || attempt >= WRITE_ATTEMPTS) throw err;
        await this.catchUp(tenantId, head.seq);
        continue;
      }
      // The event is stored: a head left behind is caught up by the next write (catchUp)
      await this.moveHead(tenantId, head.seq + 1, doc.integrityHash).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[Audit] Chain head of tenant ${tenantId} not moved: ${message}`);
      });
      return doc;
    }
  }

  private async headOf(tenantId: string): Promise<HeadPosition> {
    const head = await this.heads.findOne({ tenantId }).select('seq lastHash').lean().exec();
    return head ?? this.createHead(tenantId);
  }

  /**
   * The tenant's first write since the chain head exists: the chain continues from the newest
   * event already in the log (chained events first, if the head was lost), never from a second
   * genesis. Of two first writes at the same moment one creates the head and both use it.
   */
  private async createHead(tenantId: string): Promise<HeadPosition> {
    const anyChained: Record<string, unknown> = { tenantId, seq: chainPosition() };
    const chained = await this.events
      .findOne(anyChained)
      .sort({ seq: -1 })
      .select('seq integrityHash')
      .lean()
      .exec();
    const legacy = chained
      ? null
      : await this.events
          .findOne({ tenantId, integrityHash: { $exists: true } })
          .sort({ timestamp: -1, _id: -1 })
          .select('integrityHash')
          .lean()
          .exec();
    const start: HeadPosition = {
      seq: chained?.seq ?? 0,
      lastHash: chained?.integrityHash ?? legacy?.integrityHash ?? GENESIS_HASH,
    };
    try {
      const head = await this.heads
        .findOneAndUpdate(
          { tenantId },
          { $setOnInsert: start },
          { upsert: true, returnDocument: 'after' },
        )
        .select('seq lastHash')
        .lean()
        .exec();
      if (head) {
        this.logger.debug(`[Audit] Chain head of tenant ${tenantId} starts at seq ${head.seq}`);
        return head;
      }
    } catch (err: unknown) {
      if (!isDuplicateKey(err)) throw err;
    }
    // The other first write inserted the head between our find and our upsert
    return this.heads.findOne({ tenantId }).select('seq lastHash').lean().orFail().exec();
  }

  /** Another writer stored at least one event after `seenSeq`: move the head to the newest. */
  private async catchUp(tenantId: string, seenSeq: number): Promise<void> {
    const after: Record<string, unknown> = { tenantId, seq: chainPosition({ $gt: seenSeq }) };
    const newest = await this.events
      .findOne(after)
      .sort({ seq: -1 })
      .select('seq integrityHash')
      .lean()
      .exec();
    if (newest?.seq !== undefined) await this.moveHead(tenantId, newest.seq, newest.integrityHash);
  }

  /** Forward only: a writer that is behind leaves the head where a later event put it. */
  private async moveHead(tenantId: string, seq: number, lastHash: string): Promise<void> {
    await this.heads.updateOne({ tenantId, seq: { $lt: seq } }, { $set: { seq, lastHash } }).exec();
  }
}
