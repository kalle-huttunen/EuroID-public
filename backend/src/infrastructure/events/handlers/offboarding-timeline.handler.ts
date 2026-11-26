import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEventType } from '../event-types';
import { DomainEvent } from '../domain-event.interface';
import type {
  OffboardingCompletedPayload,
  OffboardingTargetRemovedManuallyPayload,
} from '../event-payloads';
import { UserEventService } from '../../../modules/identity/user-event.service';
import type { RecordEventDto } from '../../../modules/identity/user-event.service';
import { withTenantContext } from '../../multi-tenancy/tenant-context.helper';
import type {
  LinkedAdminOffboardingOutcome,
  OffboardingSystemResult,
} from '@shared/types/deprovision';

const SYSTEM_ENTRY: Record<
  OffboardingSystemResult['outcome'],
  { title: (system: string) => string; severity: RecordEventDto['severity'] }
> = {
  deprovisioned: { title: (s) => `Access removed: ${s}`, severity: 'success' },
  'already-gone': { title: (s) => `No account left: ${s}`, severity: 'info' },
  'not-applicable': { title: (s) => `Not applicable: ${s}`, severity: 'info' },
  failed: { title: (s) => `Access removal failed: ${s}`, severity: 'error' },
  'removed-manually': { title: (s) => `Removed manually: ${s}`, severity: 'warning' },
};

const ADMIN_OUTCOME_TEXT: Record<LinkedAdminOffboardingOutcome, string> = {
  offboarded: 'offboarded',
  failed: 'failed',
  'running-elsewhere': 'offboarding elsewhere',
};

const OUTCOME_TEXT: Record<OffboardingSystemResult['outcome'], string> = {
  deprovisioned: 'removed',
  'already-gone': 'already gone',
  'not-applicable': 'not applicable',
  failed: 'failed',
  'removed-manually': 'removed manually',
};

/**
 * Puts an offboarding's result on the identity timeline: one entry per target system (what it
 * did, or why it failed) and a summary with what became of the linked admin accounts (each has
 * its own offboarding and timeline) and of the Golden Record.
 */
@Injectable()
export class OffboardingTimelineHandler {
  private readonly logger = new Logger(OffboardingTimelineHandler.name);

  constructor(private readonly userEventService: UserEventService) {}

  @OnEvent(DomainEventType.IDENTITY_OFFBOARDING_COMPLETED, { async: true })
  async handleOffboardingCompleted(event: DomainEvent<OffboardingCompletedPayload>): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    const { identityId, workflowId, status, hubStatus, systems, linkedAdmins } = event.payload;
    const entries: Array<Omit<RecordEventDto, 'userId' | 'actor'>> = systems.map((s) => ({
      type: 'USER_DEPROVISIONED',
      severity: SYSTEM_ENTRY[s.outcome].severity,
      title: SYSTEM_ENTRY[s.outcome].title(s.system),
      ...(s.reason || s.detail ? { description: s.reason ?? s.detail } : {}),
      targetSystem: s.system,
      metadata: { workflowId, outcome: s.outcome },
    }));
    entries.push({
      type: 'WORKFLOW_COMPLETED',
      severity: status === 'completed' ? 'success' : 'error',
      title: status === 'completed' ? 'Offboarding completed' : 'Offboarding incomplete',
      description: this.summary(systems, hubStatus, linkedAdmins),
      metadata: { workflow: 'offboarding', workflowId, status, hubStatus, systems },
    });
    await this.record(tenantId, identityId, event.metadata.actor, entries);
  }

  /**
   * An admin closed a failed target by hand: one entry (the admin is its actor, their note the
   * description) and, when it was the last failed target, the offboarding's completion.
   */
  @OnEvent(DomainEventType.IDENTITY_OFFBOARDING_TARGET_REMOVED_MANUALLY, { async: true })
  async handleTargetRemovedManually(
    event: DomainEvent<OffboardingTargetRemovedManuallyPayload>,
  ): Promise<void> {
    const tenantId = event.metadata.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, skipping timeline`);
      return;
    }
    const { identityId, workflowId, system, reason, offboardingComplete } = event.payload;
    const entries: Array<Omit<RecordEventDto, 'userId' | 'actor'>> = [
      {
        type: 'USER_DEPROVISIONED',
        severity: SYSTEM_ENTRY['removed-manually'].severity,
        title: SYSTEM_ENTRY['removed-manually'].title(system),
        description: reason,
        targetSystem: system,
        metadata: { workflowId, outcome: 'removed-manually' },
      },
    ];
    if (offboardingComplete) {
      entries.push({
        type: 'WORKFLOW_COMPLETED',
        severity: 'success',
        title: 'Offboarding completed',
        description:
          'No target is left failed (the rest were removed by hand). Golden Record deleted.',
        metadata: {
          workflow: 'offboarding',
          workflowId,
          status: 'completed',
          hubStatus: 'deleted',
        },
      });
    }
    await this.record(tenantId, identityId, event.metadata.actor, entries);
  }

  private async record(
    tenantId: string,
    identityId: string,
    actor: string,
    entries: Array<Omit<RecordEventDto, 'userId' | 'actor'>>,
  ): Promise<void> {
    try {
      await withTenantContext(tenantId, async () => {
        for (const entry of entries) {
          await this.userEventService.recordEvent({ ...entry, userId: identityId, actor });
        }
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to record offboarding timeline for ${identityId}: ${message}`);
    }
  }

  private summary(
    systems: OffboardingSystemResult[],
    hubStatus: OffboardingCompletedPayload['hubStatus'],
    linkedAdmins: OffboardingCompletedPayload['linkedAdmins'] = [],
  ): string {
    const counted = (texts: string[]) => {
      const counts = new Map<string, number>();
      for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
      return [...counts].map(([text, n]) => `${n} ${text}`).join(', ');
    };
    const parts = counted(systems.map((s) => OUTCOME_TEXT[s.outcome]));
    const targets = parts ? `Targets: ${parts}.` : 'No target accounts.';
    const admins = linkedAdmins.length
      ? ` Linked admin accounts: ${counted(linkedAdmins.map((a) => ADMIN_OUTCOME_TEXT[a.outcome]))}.`
      : '';
    const adminFailed = linkedAdmins.some((a) => a.outcome === 'failed');
    const cleared = adminFailed
      ? 'the failed targets and linked admin accounts'
      : 'the failed targets';
    return hubStatus === 'deleted'
      ? `${targets}${admins} Golden Record deleted.`
      : `${targets}${admins} Golden Record suspended (login disabled) until ${cleared} are cleared.`;
  }
}
