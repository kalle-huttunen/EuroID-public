/**
 * The hash chain check over a time window (GET /audit/verify-integrity, the SOX report).
 *
 * The log has two parts. Events written before the chain head (no `seq`, hash version 1) come
 * first, oldest first by time and `_id`: their writers forked the chain (each process kept its own
 * last hash), so an event's link may point to any earlier event of the log, and their hash does
 * not cover the payload. Chained events (`seq`, hash version 2) follow in `seq` order: each must
 * link to the event at the position before it, and a missing position is tampering unless a GDPR
 * erasure entry recorded removing it. Every event is re-hashed by the rule of its own version.
 *
 * The first event of the window is checked by its own hash only (it links outside the window, or
 * to an event retention removed). Chained events are read over the positions the window's events
 * span, so an event stored at a position inside the window keeps its place even when its
 * timestamp is a few milliseconds outside it. A window that reaches now (no `to`, or a later one)
 * also finds events missing at the end of the chain (after the last stored one, before the head).
 */
import type { Model } from 'mongoose';
import type { AuditEvent, AuditEventDocument } from './schemas/audit-event.schema';
import type { AuditChainHeadDocument } from './schemas/audit-chain-head.schema';
import { GENESIS_HASH, auditEventHash } from './audit-hash';
import { chainPosition } from './audit-chain-writer';
import {
  type ErasureGap,
  type IntegrityBreakReason,
  type VerifyIntegrityResult,
  LEGACY_NOTE,
} from './audit-integrity.types';

type StoredEvent = AuditEvent & { _id: { toString(): string } };

const ERASURE = 'GDPR_ERASURE_EXECUTED';

export class AuditChainVerifier {
  private checked = 0;
  private legacyChecked = 0;
  private readonly gaps = new Map<string, ErasureGap>();

  constructor(
    private readonly events: Model<AuditEventDocument>,
    private readonly heads: Model<AuditChainHeadDocument>,
    private readonly tenantId: string,
  ) {}

  async verify(from?: Date, to?: Date): Promise<VerifyIntegrityResult> {
    const window: Record<string, Date> = {};
    if (from) window.$gte = from;
    if (to) window.$lte = to;
    const inWindow = from || to ? { timestamp: window } : {};

    const legacyHashes = new Set<string>();
    const legacy = await this.checkLegacy(inWindow, legacyHashes);
    if (legacy) return legacy;
    const upToNow = !to || to.getTime() >= Date.now();
    const chained = await this.checkChained(inWindow, legacyHashes, upToNow);
    return chained ?? this.result({ valid: true });
  }

  /** Events without `seq`, oldest first; links may point to any earlier event (forks). */
  private async checkLegacy(
    inWindow: Record<string, unknown>,
    seen: Set<string>,
  ): Promise<VerifyIntegrityResult | undefined> {
    const cursor = this.events
      .find({ tenantId: this.tenantId, ...inWindow, seq: { $exists: false } })
      .sort({ timestamp: 1, _id: 1 })
      .lean<StoredEvent[]>()
      .cursor();
    for await (const evt of cursor as AsyncIterable<StoredEvent>) {
      this.checked++;
      this.legacyChecked++;
      if (auditEventHash(evt as unknown as Record<string, unknown>) !== evt.integrityHash) {
        return this.broken(evt, 'hash_mismatch');
      }
      if (this.legacyChecked > 1 && !(await this.legacyLinkHolds(evt, seen))) {
        return this.broken(evt, 'broken_link');
      }
      seen.add(evt.integrityHash);
    }
    return undefined;
  }

  /** Chained events over the positions the window spans, each linked to the one before it. */
  private async checkChained(
    inWindow: Record<string, unknown>,
    legacyHashes: Set<string>,
    upToNow: boolean,
  ): Promise<VerifyIntegrityResult | undefined> {
    const span: Record<string, unknown> = {
      tenantId: this.tenantId,
      ...inWindow,
      seq: chainPosition(),
    };
    const [low, high] = await Promise.all([
      this.events.findOne(span).sort({ seq: 1 }).select('seq').lean().exec(),
      this.events.findOne(span).sort({ seq: -1 }).select('seq').lean().exec(),
    ]);
    if (low?.seq === undefined || high?.seq === undefined) return undefined;

    const cursor = this.events
      .find({ tenantId: this.tenantId, seq: chainPosition({ $gte: low.seq, $lte: high.seq }) })
      .sort({ seq: 1 })
      .lean<StoredEvent[]>()
      .cursor();
    let prev: StoredEvent | undefined;
    for await (const evt of cursor as AsyncIterable<StoredEvent>) {
      this.checked++;
      const seq = evt.seq as number;
      if (auditEventHash(evt as unknown as Record<string, unknown>) !== evt.integrityHash) {
        return this.broken(evt, 'hash_mismatch');
      }
      if (!prev) {
        // The chain's start right after the window's older events links to one of them
        if (
          seq === 1 &&
          legacyHashes.size > 0 &&
          !(await this.legacyLinkHolds(evt, legacyHashes))
        ) {
          return this.broken(evt, 'broken_link');
        }
      } else if (seq === (prev.seq as number) + 1) {
        if (evt.previousHash !== prev.integrityHash) return this.broken(evt, 'broken_link');
      } else {
        const unexplained = await this.explainGap(prev.seq as number, seq);
        if (unexplained > 0) return this.broken(evt, 'missing_events', unexplained);
        // The event before it was erased: its link cannot be checked
      }
      prev = evt;
    }
    return upToNow && prev ? this.checkTail(prev.seq as number) : undefined;
  }

  /** Positions after the newest stored event that the head has passed: removed tail events. */
  private async checkTail(lastSeq: number): Promise<VerifyIntegrityResult | undefined> {
    const head = await this.heads.findOne({ tenantId: this.tenantId }).select('seq').lean().exec();
    if (!head || head.seq <= lastSeq) return undefined;
    // Events written while the check ran are not missing
    const anyChained: Record<string, unknown> = { tenantId: this.tenantId, seq: chainPosition() };
    const newest = await this.events
      .findOne(anyChained)
      .sort({ seq: -1 })
      .select('seq')
      .lean()
      .exec();
    const stored = Math.max(lastSeq, newest?.seq ?? 0);
    if (head.seq <= stored) return undefined;
    const unexplained = await this.explainGap(stored, head.seq + 1);
    if (unexplained === 0) return undefined;
    return this.result({
      valid: false,
      reason: 'missing_events',
      firstInvalidSeq: stored + 1,
      missingEvents: unexplained,
    });
  }

  /**
   * A version 1 link holds when it points to the genesis hash (two first writes), to an earlier
   * event of the window, to an earlier event outside it, or to an event a GDPR erasure recorded
   * removing.
   */
  private async legacyLinkHolds(evt: StoredEvent, seen: Set<string>): Promise<boolean> {
    if (evt.previousHash === GENESIS_HASH || seen.has(evt.previousHash)) return true;
    const earlier = await this.events
      .exists({
        tenantId: this.tenantId,
        integrityHash: evt.previousHash,
        timestamp: { $lte: evt.timestamp },
      })
      .exec();
    if (earlier) return true;
    const erasure = await this.events
      .findOne({
        tenantId: this.tenantId,
        action: ERASURE,
        'payload.metadata.removedLegacyHashes': evt.previousHash,
      })
      .select('timestamp')
      .lean()
      .exec();
    if (!erasure) return false;
    this.recordGap(erasure._id.toString(), erasure.timestamp, 1);
    return true;
  }

  /**
   * Counts the positions strictly between `after` and `before` that no GDPR erasure recorded
   * removing. An erasure entry counts only for events before its own position.
   */
  private async explainGap(after: number, before: number): Promise<number> {
    const missing = before - after - 1;
    const erasures = await this.events
      .find({
        tenantId: this.tenantId,
        action: ERASURE,
        seq: chainPosition({ $gt: after + 1 }),
        'payload.metadata.removedSeqs': { $elemMatch: { $gt: after, $lt: before } },
      })
      .select('seq timestamp payload.metadata.removedSeqs')
      .lean()
      .exec();
    const explained = new Set<number>();
    for (const entry of erasures) {
      const removed = (entry.payload?.metadata?.removedSeqs ?? []) as number[];
      const inGap = removed.filter(
        (s) => s > after && s < before && s < (entry.seq as number) && !explained.has(s),
      );
      inGap.forEach((s) => explained.add(s));
      if (inGap.length) this.recordGap(entry._id.toString(), entry.timestamp, inGap.length);
    }
    return missing - explained.size;
  }

  private recordGap(erasureEntryId: string, at: Date, removed: number): void {
    const gap = this.gaps.get(erasureEntryId);
    if (gap) gap.eventsRemoved += removed;
    else {
      this.gaps.set(erasureEntryId, {
        erasureEntryId,
        erasedAt: new Date(at).toISOString(),
        eventsRemoved: removed,
      });
    }
  }

  private broken(
    evt: StoredEvent,
    reason: IntegrityBreakReason,
    missingEvents?: number,
  ): VerifyIntegrityResult {
    return this.result({
      valid: false,
      firstInvalid: evt._id.toString(),
      firstInvalidAt: new Date(evt.timestamp).toISOString(),
      ...(evt.seq !== undefined ? { firstInvalidSeq: evt.seq } : {}),
      reason,
      ...(missingEvents !== undefined ? { missingEvents } : {}),
    });
  }

  private result(
    outcome: Omit<VerifyIntegrityResult, 'eventsChecked' | 'legacyEventsChecked' | 'erasureGaps'>,
  ): VerifyIntegrityResult {
    return {
      ...outcome,
      eventsChecked: this.checked,
      legacyEventsChecked: this.legacyChecked,
      ...(this.legacyChecked > 0 ? { legacyNote: LEGACY_NOTE } : {}),
      erasureGaps: [...this.gaps.values()],
    };
  }
}
