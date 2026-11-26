import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import type {
  MoverCompletedPayload,
  MoverFailedPayload,
  MoverStartedPayload,
} from '../event-payloads';
import { UserEventService } from '../../../modules/identity/user-event.service';
import type { RecordEventDto } from '../../../modules/identity/user-event.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';
import type { MoverOutcome, MoverSystemResult } from '@shared/types/mover';

type Entry = Omit<RecordEventDto, 'userId' | 'actor'>;

const SYSTEM_ENTRY: Record<
  MoverSystemResult['outcome'],
  { title: (system: string) => string; severity: RecordEventDto['severity'] }
> = {
  updated: { title: (s) => `Access updated: ${s}`, severity: 'success' },
  failed: { title: (s) => `Access update failed: ${s}`, severity: 'error' },
  'not-supported': { title: (s) => `Not updated by the mover: ${s}`, severity: 'warning' },
  'not-attempted': { title: (s) => `Not attempted: ${s}`, severity: 'warning' },
  'no-account': { title: (s) => `No account: ${s}`, severity: 'warning' },
};

const SUMMARY: Record<
  MoverOutcome['status'],
  { title: string; severity: RecordEventDto['severity'] }
> = {
  completed: { title: 'Access change completed', severity: 'success' },
  'no-change': { title: 'Access change: nothing to change', severity: 'info' },
  skipped: { title: 'Access change skipped', severity: 'warning' },
  failed: { title: 'Access change failed', severity: 'error' },
};

const TRIGGER_TITLE: Record<MoverStartedPayload['trigger'], string> = {
  'attribute-change': 'Access change started',
  're-evaluate': 'Access re-evaluation started',
  'hr-sync': 'Access change started by HR sync',
};

/** "added A, B; removed C" (the entitlement ids). */
function changeText(s: MoverSystemResult): string {
  const parts = [
    s.added.length ? `added ${s.added.join(', ')}` : '',
    s.removed.length ? `removed ${s.removed.join(', ')}` : '',
  ].filter(Boolean);
  return parts.join('; ');
}

function systemDescription(s: MoverSystemResult): string {
  const changes = changeText(s);
  // An Entra ID sync the edit asked for (syncToEntra) has no access change to name
  const notApplied = changes ? ` Not applied: ${changes}.` : '';
  switch (s.outcome) {
    case 'updated':
      return changes || (s.reason ?? '');
    case 'failed':
      return changes
        ? `${s.reason ?? 'Unknown error'} (not applied: ${changes})`
        : (s.reason ?? 'Unknown error');
    case 'not-supported': {
      // Runs from before patch mover:identity-by-id give no reason: they updated Entra ID and AD
      const why = s.reason ?? 'The mover updated Entra ID and Active Directory only.';
      return `${why}${notApplied}`;
    }
    case 'not-attempted':
      return `Stopped at an earlier system's failure.${notApplied}`;
    case 'no-account': {
      const why = s.reason ?? 'The identity has no account in this system.';
      return `${why}${notApplied}`;
    }
  }
}

function summaryDescription(o: MoverOutcome): string {
  const fields = o.changedFields.length ? ` (${o.changedFields.join(', ')})` : '';
  switch (o.status) {
    case 'completed': {
      const left = o.systems.filter((s) => s.outcome !== 'updated').map((s) => s.system);
      const rest = left.length ? ` Not applied in: ${left.join(', ')}.` : '';
      return `+${o.added} / -${o.removed} entitlements${fields}.${rest}`;
    }
    case 'no-change':
      return `The policies give the same entitlements${fields}.`;
    case 'skipped':
      return o.reason ?? 'Skipped.';
    case 'failed':
      return o.reason ?? 'Failed.';
  }
}

/**
 * Puts mover runs on the identity timeline: the start (what changed, who started it), then one
 * entry per target system with changes (what was added and removed, or why not) and a summary.
 * Written like OffboardingTimelineHandler; the events carry no names or emails.
 */
@Injectable()
export class MoverTimelineHandler {
  private readonly logger = new Logger(MoverTimelineHandler.name);

  constructor(private readonly userEventService: UserEventService) {}

  @OnEvent(DomainEventType.MOVER_STARTED, { async: true })
  async handleMoverStarted(event: DomainEvent<MoverStartedPayload>): Promise<void> {
    const { identityId, workflowId, trigger, changedFields } = event.payload;
    await this.record(event, identityId, [
      {
        type: 'WORKFLOW_STARTED',
        severity: 'info',
        title: TRIGGER_TITLE[trigger],
        description: changedFields.length
          ? `Changed: ${changedFields.join(', ')}`
          : 'No attribute changed since access was last applied.',
        metadata: { workflow: 'mover', workflowId, trigger, changedFields },
      },
    ]);
  }

  @OnEvent(DomainEventType.MOVER_COMPLETED, { async: true })
  async handleMoverCompleted(event: DomainEvent<MoverCompletedPayload>): Promise<void> {
    await this.recordOutcome(event);
  }

  @OnEvent(DomainEventType.MOVER_FAILED, { async: true })
  async handleMoverFailed(event: DomainEvent<MoverFailedPayload>): Promise<void> {
    await this.recordOutcome(event);
  }

  private async recordOutcome(event: DomainEvent<MoverOutcome>): Promise<void> {
    const o = event.payload;
    const entries: Entry[] = o.systems.map((s) => ({
      type: 'USER_PROVISIONED',
      severity: SYSTEM_ENTRY[s.outcome].severity,
      title: SYSTEM_ENTRY[s.outcome].title(s.system),
      description: systemDescription(s),
      targetSystem: s.system,
      metadata: {
        workflowId: o.workflowId,
        outcome: s.outcome,
        added: s.added,
        removed: s.removed,
      },
    }));
    entries.push({
      type: 'WORKFLOW_COMPLETED',
      severity: SUMMARY[o.status].severity,
      title: SUMMARY[o.status].title,
      description: summaryDescription(o),
      metadata: {
        workflow: 'mover',
        workflowId: o.workflowId,
        trigger: o.trigger,
        status: o.status,
        changedFields: o.changedFields,
        added: o.added,
        removed: o.removed,
        durationMs: o.durationMs,
      },
    });
    await this.record(event, o.identityId, entries);
  }

  private async record(event: DomainEvent<unknown>, identityId: string, entries: Entry[]) {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    try {
      await withTenantContext(tenantId, async () => {
        for (const entry of entries) {
          await this.userEventService.recordEvent({
            ...entry,
            userId: identityId,
            actor: event.metadata.actor,
          });
        }
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record mover timeline for ${identityId}: ${message}`);
    }
  }
}
