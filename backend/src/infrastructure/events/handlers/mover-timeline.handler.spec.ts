import { MoverTimelineHandler } from './mover-timeline.handler';
import { DomainEventType } from '../event-types';
import { getEventSchema } from '../event-payload-schemas';
import type { DomainEvent } from '../domain-event.interface';
import type { MoverStartedPayload } from '../event-payloads';
import type { UserEventService } from '../../../modules/identity/user-event.service';
import { requestContext } from '../../middleware/correlation.middleware';
import type { MoverOutcome } from '@shared/types/mover';

function event<T>(
  type: DomainEventType,
  payload: T,
  actor: string,
  tenantId = 'tenant-a',
): DomainEvent<T> {
  return {
    eventId: 'e1',
    type,
    aggregateId: 'id-1',
    timestamp: new Date().toISOString(),
    payload,
    metadata: { correlationId: 'c', depth: 0, emittedBy: 'test', actor, tenantId },
  };
}

const outcome = (over: Partial<MoverOutcome> = {}): MoverOutcome => ({
  identityId: 'id-1',
  workflowId: 'wf-1',
  trigger: 're-evaluate',
  status: 'completed',
  changedFields: ['departmentName'],
  added: 2,
  removed: 1,
  systems: [
    { system: 'entra-id', outcome: 'updated', added: ['g-eng'], removed: ['g-sales'] },
    {
      system: 'github',
      outcome: 'not-supported',
      added: ['gh-eng'],
      removed: [],
      reason: 'The mover updates Entra ID, Active Directory, Okta and SCIM only.',
    },
  ],
  durationMs: 900,
  ...over,
});

describe('MoverTimelineHandler', () => {
  const tenants: string[] = [];
  const recordEvent = jest.fn(async () => {
    tenants.push(requestContext.getStore()?.tenantId ?? '');
    return {};
  });
  const handler = new MoverTimelineHandler({ recordEvent } as unknown as UserEventService);
  const entries = () => recordEvent.mock.calls.map((c) => (c as unknown[])[0]);

  beforeEach(() => {
    recordEvent.mockClear();
    tenants.length = 0;
  });

  it('records the start: what changed and who started it, in the event tenant', async () => {
    await handler.handleMoverStarted(
      event<MoverStartedPayload>(
        DomainEventType.MOVER_STARTED,
        {
          identityId: 'id-1',
          workflowId: 'wf-1',
          trigger: 're-evaluate',
          changedFields: ['departmentName', 'costCenter'],
        },
        'ops@acme.test',
      ),
    );

    expect(entries()).toEqual([
      {
        userId: 'id-1',
        actor: 'ops@acme.test',
        type: 'WORKFLOW_STARTED',
        severity: 'info',
        title: 'Access re-evaluation started',
        description: 'Changed: departmentName, costCenter',
        metadata: {
          workflow: 'mover',
          workflowId: 'wf-1',
          trigger: 're-evaluate',
          changedFields: ['departmentName', 'costCenter'],
        },
      },
    ]);
    expect(tenants).toEqual(['tenant-a']);
  });

  it('records each system with changes and a summary of a completed run', async () => {
    await handler.handleMoverCompleted(
      event(DomainEventType.MOVER_COMPLETED, outcome(), 'mover-workflow'),
    );

    expect(entries()).toEqual([
      expect.objectContaining({
        type: 'USER_PROVISIONED',
        severity: 'success',
        title: 'Access updated: entra-id',
        description: 'added g-eng; removed g-sales',
        targetSystem: 'entra-id',
        metadata: {
          workflowId: 'wf-1',
          outcome: 'updated',
          added: ['g-eng'],
          removed: ['g-sales'],
        },
      }),
      expect.objectContaining({
        severity: 'warning',
        title: 'Not updated by the mover: github',
        description:
          'The mover updates Entra ID, Active Directory, Okta and SCIM only. Not applied: added gh-eng.',
      }),
      expect.objectContaining({
        type: 'WORKFLOW_COMPLETED',
        severity: 'success',
        title: 'Access change completed',
        description: '+2 / -1 entitlements (departmentName). Not applied in: github.',
      }),
    ]);
    expect(tenants).toEqual(['tenant-a', 'tenant-a', 'tenant-a']);
  });

  it('records a failed run: the failing system with its reason, the rest not attempted', async () => {
    await handler.handleMoverFailed(
      event(
        DomainEventType.MOVER_FAILED,
        outcome({
          status: 'failed',
          reason: 'Graph refused the change',
          systems: [
            {
              system: 'entra-id',
              outcome: 'failed',
              added: ['g-eng'],
              removed: [],
              reason: 'Graph refused the change',
            },
            { system: 'ad', outcome: 'not-attempted', added: ['ad-eng'], removed: [] },
          ],
        }),
        'mover-workflow',
      ),
    );

    expect(entries()).toEqual([
      expect.objectContaining({
        severity: 'error',
        title: 'Access update failed: entra-id',
        description: 'Graph refused the change (not applied: added g-eng)',
      }),
      expect.objectContaining({ severity: 'warning', title: 'Not attempted: ad' }),
      expect.objectContaining({
        type: 'WORKFLOW_COMPLETED',
        severity: 'error',
        title: 'Access change failed',
        description: 'Graph refused the change',
      }),
    ]);
  });

  it('records a system where the identity has no account as such, with its reason', async () => {
    const noAccount = outcome({
      systems: [
        { system: 'entra-id', outcome: 'updated', added: ['g-eng'], removed: ['g-sales'] },
        {
          system: 'okta',
          outcome: 'no-account',
          added: ['okta-eng'],
          removed: ['okta-sales'],
          reason: 'The identity is not provisioned to this system.',
        },
      ],
    });
    // The payload passes the event's schema, or the emitter would drop the event
    expect(getEventSchema(DomainEventType.MOVER_COMPLETED).safeParse(noAccount).success).toBe(true);

    await handler.handleMoverCompleted(
      event(DomainEventType.MOVER_COMPLETED, noAccount, 'mover-workflow'),
    );

    expect(entries()).toEqual([
      expect.objectContaining({ title: 'Access updated: entra-id' }),
      expect.objectContaining({
        severity: 'warning',
        title: 'No account: okta',
        description:
          'The identity is not provisioned to this system. ' +
          'Not applied: added okta-eng; removed okta-sales.',
        targetSystem: 'okta',
        metadata: expect.objectContaining({ outcome: 'no-account' }),
      }),
      expect.objectContaining({
        severity: 'success',
        title: 'Access change completed',
        description: '+2 / -1 entitlements (departmentName). Not applied in: okta.',
      }),
    ]);
  });

  it('says what the mover updated when a run from before mover:identity-by-id gives no reason', async () => {
    await handler.handleMoverCompleted(
      event(
        DomainEventType.MOVER_COMPLETED,
        outcome({
          systems: [{ system: 'okta', outcome: 'not-supported', added: ['okta-eng'], removed: [] }],
        }),
        'mover-workflow',
      ),
    );
    expect(entries()[0]).toEqual(
      expect.objectContaining({
        title: 'Not updated by the mover: okta',
        description:
          'The mover updated Entra ID and Active Directory only. Not applied: added okta-eng.',
      }),
    );
  });

  it('records a run without changes as one summary', async () => {
    await handler.handleMoverCompleted(
      event(
        DomainEventType.MOVER_COMPLETED,
        outcome({ status: 'no-change', added: 0, removed: 0, systems: [] }),
        'mover-workflow',
      ),
    );
    expect(entries()).toEqual([
      expect.objectContaining({
        severity: 'info',
        title: 'Access change: nothing to change',
        description: 'The policies give the same entitlements (departmentName).',
      }),
    ]);
  });

  it('says why Entra ID was updated or not in a run without changes that synced it', async () => {
    const synced = 'The edit asked for a sync to Entra ID: the account was updated.';
    const noAccount = 'The identity is not provisioned to this system.';
    const payload = outcome({
      trigger: 'attribute-change',
      status: 'no-change',
      added: 0,
      removed: 0,
      systems: [
        { system: 'entra-id', outcome: 'updated', added: [], removed: [], reason: synced },
        { system: 'entra', outcome: 'no-account', added: [], removed: [], reason: noAccount },
        { system: 'entra-eu', outcome: 'not-attempted', added: [], removed: [] },
        { system: 'entra-us', outcome: 'failed', added: [], removed: [], reason: 'Graph down' },
      ],
    });
    expect(getEventSchema(DomainEventType.MOVER_COMPLETED).safeParse(payload).success).toBe(true);

    await handler.handleMoverCompleted(
      event(DomainEventType.MOVER_COMPLETED, payload, 'mover-workflow'),
    );

    expect(entries().slice(0, 4)).toEqual([
      expect.objectContaining({ title: 'Access updated: entra-id', description: synced }),
      expect.objectContaining({ title: 'No account: entra', description: noAccount }),
      expect.objectContaining({
        title: 'Not attempted: entra-eu',
        description: "Stopped at an earlier system's failure.",
      }),
      expect.objectContaining({
        title: 'Access update failed: entra-us',
        description: 'Graph down',
      }),
    ]);
  });

  it('skips an event without a tenant', async () => {
    await handler.handleMoverCompleted(
      event(DomainEventType.MOVER_COMPLETED, outcome(), 'mover-workflow', ''),
    );
    expect(recordEvent).not.toHaveBeenCalled();
  });
});
