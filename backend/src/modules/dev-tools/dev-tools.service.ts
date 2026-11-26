/**
 * Dev Tools Service
 *
 * Queries workflow executions from Temporal Visibility API and transaction logs from MongoDB
 * for the Developer Tools pages (Workflow Debugger and Transaction Viewer).
 * Workflow data is sourced from Temporal; no local MongoDB duplication.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Client } from '@temporalio/client';
import type { WorkflowExecutionInfo } from '@temporalio/client';
import type { Payload } from '@temporalio/common';

/** Minimal history shape from handle.fetchHistory() for step mapping */
interface TemporalHistory {
  events?: Array<{
    eventId?: number;
    eventTime?: { seconds?: bigint | number; nanos?: number };
    activityTaskScheduledEventAttributes?: {
      activityId?: string;
      activityType?: { name?: string };
    };
    activityTaskStartedEventAttributes?: { scheduledEventId?: number };
    activityTaskCompletedEventAttributes?: {
      scheduledEventId?: number;
      result?: { payloads?: Payload[] };
    };
    activityTaskFailedEventAttributes?: {
      scheduledEventId?: number;
      failure?: { message?: string };
    };
  }>;
}
import {
  TransactionLog,
  TransactionLogDocument,
  TransactionPhase,
  SystemParticipant,
  TERMINAL_TRANSACTION_PHASES,
} from './schemas/transaction-log.schema';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { getTenantWorkflow } from '@infrastructure/temporal/tenant-workflow';
import { tenantVisibilityQuery } from '@infrastructure/temporal/tenant-search-attribute';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose FilterQuery requires any for flexible query operators
type FilterQuery<_T> = Record<string, any>;

// ── Workflow types (frontend contract) ─────────────────────────────────

export type WorkflowType =
  | 'ONBOARDING'
  | 'OFFBOARDING'
  | 'RECONCILIATION'
  | 'BULK_PROVISIONING'
  | 'DISTRIBUTED_TRANSACTION';

export type WorkflowStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';

export interface WorkflowStep {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  output?: Record<string, unknown>;
  error?: string;
}

export interface WorkflowExecutionDto {
  workflowId: string;
  type: WorkflowType;
  status: WorkflowStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  triggeredBy: string;
  targetDescription: string;
  steps: WorkflowStep[];
  metadata?: Record<string, unknown>;
}

// ── DTOs ─────────────────────────────────────────────────────────────

export interface RecordTransactionDto {
  transactionId: string;
  workflowId: string;
  operation: string;
  initiatedBy: string;
  targetUser?: string;
  participants: SystemParticipant[];
  autoRollback?: boolean;
  timeout?: number;
  notes?: string;
  tenantId?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

function inferWorkflowType(workflowId: string): WorkflowType {
  if (workflowId.includes('onboard')) return 'ONBOARDING';
  if (workflowId.includes('offboard')) return 'OFFBOARDING';
  if (workflowId.includes('daily-recon') || workflowId.includes('user-recon'))
    return 'RECONCILIATION';
  if (workflowId.includes('dist-tx')) return 'DISTRIBUTED_TRANSACTION';
  if (workflowId.includes('bulk')) return 'BULK_PROVISIONING';
  return 'ONBOARDING';
}

function mapTemporalStatus(statusName: string): WorkflowStatus {
  const m: Record<string, WorkflowStatus> = {
    RUNNING: 'RUNNING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    TIMED_OUT: 'TIMED_OUT',
    CANCELLED: 'CANCELLED',
    TERMINATED: 'CANCELLED',
    CONTINUED_AS_NEW: 'COMPLETED',
  };
  return m[statusName] ?? 'RUNNING';
}

/**
 * Activity results as the client's data converter reads them: the payload codec stores them
 * encrypted (temporal-payload-codec.ts), and fetchHistory() returns the history as stored.
 */
async function decodeActivityResults(history: TemporalHistory, client: Client): Promise<void> {
  for (const ev of history.events ?? []) {
    const result = ev.activityTaskCompletedEventAttributes?.result;
    let payloads = result?.payloads;
    if (!result || !payloads?.length) continue;
    for (const codec of [...client.options.loadedDataConverter.payloadCodecs].reverse()) {
      payloads = await codec.decode(payloads);
    }
    result.payloads = payloads;
  }
}

function mapTemporalHistoryToSteps(history: TemporalHistory): WorkflowStep[] {
  const byScheduledId = new Map<number, Partial<WorkflowStep>>();
  const events = history.events ?? [];

  for (const ev of events) {
    const eventId = ev.eventId ?? 0;
    const eventTime = ev.eventTime
      ? new Date(
          Number(ev.eventTime.seconds) * 1000 + Number(ev.eventTime.nanos ?? 0) / 1e6,
        ).toISOString()
      : undefined;

    if (ev.activityTaskScheduledEventAttributes) {
      const a = ev.activityTaskScheduledEventAttributes;
      const name = a.activityType?.name ?? `Activity-${a.activityId ?? eventId}`;
      byScheduledId.set(eventId, { name, status: 'pending' });
    } else if (ev.activityTaskStartedEventAttributes) {
      const scheduledId = ev.activityTaskStartedEventAttributes.scheduledEventId ?? 0;
      const step = byScheduledId.get(scheduledId);
      if (step) {
        step.status = 'running';
        step.startedAt = eventTime;
      }
    } else if (ev.activityTaskCompletedEventAttributes) {
      const a = ev.activityTaskCompletedEventAttributes;
      const scheduledId = a.scheduledEventId ?? 0;
      const step = byScheduledId.get(scheduledId);
      if (step) {
        step.status = 'completed';
        step.completedAt = eventTime;
        if (step.startedAt && step.completedAt) {
          step.durationMs =
            new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
        }
        const result = a.result;
        if (result?.payloads?.[0]?.data) {
          try {
            const raw: unknown = JSON.parse(
              Buffer.from(result.payloads[0].data as Uint8Array).toString('utf8'),
            );
            step.output =
              typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
          } catch {
            step.output = {};
          }
        }
      }
    } else if (ev.activityTaskFailedEventAttributes) {
      const a = ev.activityTaskFailedEventAttributes;
      const scheduledId = a.scheduledEventId ?? 0;
      const step = byScheduledId.get(scheduledId);
      if (step) {
        step.status = 'failed';
        step.completedAt = eventTime;
        if (step.startedAt && step.completedAt) {
          step.durationMs =
            new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
        }
        step.error = (a.failure as { message?: string })?.message ?? 'Activity failed';
      }
    }
  }

  return Array.from(byScheduledId.values())
    .filter((s): s is WorkflowStep => !!s.name)
    .map((s) => ({
      name: s.name,
      status: s.status ?? 'pending',
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      durationMs: s.durationMs,
      output: s.output,
      error: s.error,
    }));
}

// ── Service ──────────────────────────────────────────────────────────

@Injectable()
export class DevToolsService {
  private readonly logger = new Logger(DevToolsService.name);

  constructor(
    @InjectModel(TransactionLog.name)
    private readonly transactionModel: Model<TransactionLogDocument>,
    private readonly temporalClientProvider: TemporalClientProvider,
  ) {}

  private getClient(): Client | null {
    return this.temporalClientProvider.isConnected()
      ? this.temporalClientProvider.getClient()
      : null;
  }

  private mapExecutionToDto(
    info: WorkflowExecutionInfo,
    steps?: WorkflowStep[],
  ): WorkflowExecutionDto {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Temporal WorkflowExecutionInfo memo typing incomplete
    const memo = (info as any).memo as Record<string, unknown> | undefined;
    const triggeredBy = (memo?.triggeredBy as string) ?? 'System';
    const targetDescription = (memo?.targetDescription as string) ?? info.workflowId;
    const startedAt = info.startTime?.toISOString?.() ?? new Date().toISOString();
    const completedAt = info.closeTime?.toISOString?.();
    const durationMs =
      info.closeTime && info.startTime
        ? info.closeTime.getTime() - info.startTime.getTime()
        : undefined;

    return {
      workflowId: info.workflowId,
      type: inferWorkflowType(info.workflowId),
      status: mapTemporalStatus(info.status?.name ?? 'RUNNING'),
      startedAt,
      completedAt,
      durationMs,
      triggeredBy,
      targetDescription,
      steps: steps ?? [],
    };
  }

  // ── Workflow Executions (Temporal) ───────────────────────────────────

  /**
   * List recent workflow executions from Temporal Visibility API.
   */
  async listWorkflows(filters?: {
    type?: WorkflowType;
    status?: WorkflowStatus;
    tenantId?: string;
    limit?: number;
  }): Promise<WorkflowExecutionDto[]> {
    const client = this.getClient();
    if (!client) return [];

    const limit = filters?.limit ?? 50;
    const queryParts: string[] = [];
    if (filters?.tenantId) {
      queryParts.push(tenantVisibilityQuery(filters.tenantId));
    }
    const query = queryParts.length > 0 ? queryParts.join(' AND ') : undefined;

    try {
      const iter = client.workflow.list({
        query,
        pageSize: limit,
      });
      const results: WorkflowExecutionDto[] = [];
      for await (const info of iter) {
        if (results.length >= limit) break;
        const dto = this.mapExecutionToDto(info);
        if (filters?.type && dto.type !== filters.type) continue;
        if (filters?.status && dto.status !== filters.status) continue;
        results.push(dto);
      }
      return results;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[DevTools] listWorkflows failed: ${message}`);
      return [];
    }
  }

  /**
   * Get a single workflow execution of the caller's tenant by ID from Temporal. Null when it
   * does not exist, belongs to another tenant (getTenantWorkflow) or Temporal is unavailable.
   */
  async getWorkflowDetail(workflowId: string): Promise<WorkflowExecutionDto | null> {
    const client = this.getClient();
    if (!client) return null;

    try {
      const { handle, description } = await getTenantWorkflow(client, workflowId);
      let steps: WorkflowStep[] = [];
      try {
        const history = (await handle.fetchHistory()) as unknown as TemporalHistory;
        await decodeActivityResults(history, client);
        steps = mapTemporalHistoryToSteps(history);
      } catch (err: unknown) {
        // History fetch may fail for very old workflows; a payload this process cannot decrypt
        // fails here too (TemporalPayloadDecryptionError names the key id)
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[DevTools] history of ${workflowId} not read: ${message}`);
      }
      return this.mapExecutionToDto(description as WorkflowExecutionInfo, steps);
    } catch {
      return null;
    }
  }

  // ── Distributed Transactions (MongoDB) ───────────────────────────────

  async recordTransaction(dto: RecordTransactionDto): Promise<TransactionLogDocument> {
    const doc = await this.transactionModel.findOneAndUpdate(
      { transactionId: dto.transactionId },
      {
        $set: {
          tenantId: dto.tenantId ?? 'default',
          workflowId: dto.workflowId,
          phase: 'PREPARING' as TransactionPhase,
          operation: dto.operation,
          startedAt: new Date(),
          initiatedBy: dto.initiatedBy,
          targetUser: dto.targetUser,
          participants: dto.participants,
          autoRollback: dto.autoRollback ?? true,
          timeout: dto.timeout ?? 300000,
          notes: dto.notes,
        },
      },
      { upsert: true, new: true },
    );
    this.logger.debug(`[DevTools] Recorded transaction: ${dto.transactionId}`);
    return doc;
  }

  /**
   * Record a phase transition (called by DistributedTransactionActivities, under the
   * transaction's tenant). A terminal phase sets completedAt; any other phase clears it, since a
   * failed commit records FAILED and the rollback then moves the phase on.
   */
  async updateTransactionPhase(
    transactionId: string,
    phase: TransactionPhase,
    participants?: SystemParticipant[],
  ): Promise<void> {
    const update: Record<string, unknown> = { phase };
    const finished = TERMINAL_TRANSACTION_PHASES.includes(phase);
    if (finished) {
      update.completedAt = new Date();
    }
    if (participants) {
      update.participants = participants;
    }
    await this.transactionModel.findOneAndUpdate(
      { transactionId },
      finished ? { $set: update } : { $set: update, $unset: { completedAt: 1 } },
    );
  }

  async listTransactions(filters?: {
    phase?: TransactionPhase;
    limit?: number;
  }): Promise<TransactionLogDocument[]> {
    const q: FilterQuery<TransactionLogDocument> = {};
    if (filters?.phase) q.phase = filters.phase;

    return this.transactionModel
      .find(q)
      .sort({ startedAt: -1 })
      .limit(filters?.limit || 50)
      .exec();
  }

  async getTransactionDetail(transactionId: string): Promise<TransactionLogDocument | null> {
    return this.transactionModel.findOne({ transactionId }).exec();
  }
}
