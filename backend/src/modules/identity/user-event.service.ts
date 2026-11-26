/**
 * User Event Service
 *
 * Records and queries per-user lifecycle events for the Timeline tab.
 * Other services/activities call recordEvent() to create timeline entries.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

type FilterQuery<_T> = Record<string, unknown>;

import {
  UserEvent,
  UserEventDocument,
  TimelineEventType,
  TimelineEventSeverity,
} from './schemas/user-event.schema';

// ── DTO for recording events ─────────────────────────────────────────

export interface RecordEventDto {
  userId: string;
  type: TimelineEventType;
  severity?: TimelineEventSeverity;
  title: string;
  description?: string;
  actor: string;
  targetSystem?: string;
  metadata?: Record<string, unknown>;
  /** The domain event the entry records: one entry of its type per event. */
  eventId?: string;
}

/** A write refused by a unique index (MongoDB duplicate key). */
const isDuplicateKey = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;

// ── Filter for querying events ───────────────────────────────────────

export interface UserEventFilter {
  type?: TimelineEventType | TimelineEventType[];
  dateFrom?: string;
  dateTo?: string;
}

// ── Service ──────────────────────────────────────────────────────────

@Injectable()
export class UserEventService {
  private readonly logger = new Logger(UserEventService.name);

  constructor(
    @InjectModel(UserEvent.name)
    private readonly eventModel: Model<UserEventDocument>,
  ) {}

  /**
   * Record a timeline event for a user. Fire-and-forget safe. With `eventId`, an entry of the same
   * type for that event already there is answered instead (a redelivered event writes none).
   */
  async recordEvent(dto: RecordEventDto): Promise<UserEventDocument> {
    try {
      const doc = await this.eventModel.create({
        ...dto,
        severity: dto.severity ?? 'info',
        timestamp: new Date(),
      });
      this.logger.debug(`[UserEvent] ${dto.type} for user ${dto.userId}: ${dto.title}`);
      return doc;
    } catch (error: unknown) {
      if (dto.eventId && isDuplicateKey(error)) {
        const existing = await this.eventModel
          .findOne({ eventId: dto.eventId, type: dto.type })
          .exec();
        if (existing) return existing;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[UserEvent] Failed to record: ${message}`);
      throw error;
    }
  }

  /**
   * Query events for a specific user with optional filters.
   */
  async getEvents(
    userId: string,
    filter?: UserEventFilter,
    limit = 50,
  ): Promise<UserEventDocument[]> {
    const q: FilterQuery<UserEventDocument> = { userId };

    if (filter?.type) {
      q.type = Array.isArray(filter.type) ? { $in: filter.type } : filter.type;
    }
    if (filter?.dateFrom || filter?.dateTo) {
      const tsFilter: { $gte?: Date; $lte?: Date } = {};
      if (filter.dateFrom) tsFilter.$gte = new Date(filter.dateFrom);
      if (filter.dateTo) tsFilter.$lte = new Date(filter.dateTo);
      q.timestamp = tsFilter;
    }

    return this.eventModel.find(q).sort({ timestamp: -1 }).limit(limit).exec();
  }
}
