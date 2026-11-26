import type { Model } from 'mongoose';
import { LeaverOffboardingResultHandler } from './leaver-offboarding-result.handler';
import type { OffboardingRecordDocument } from './schemas/offboarding-record.schema';
import type { LeaverEventDocument } from './schemas/leaver-event.schema';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import type { OffboardingCompletedPayload } from '@infrastructure/events/event-payloads';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';

describe('LeaverOffboardingResultHandler', () => {
  const tenants: string[] = [];
  const updateOne = jest.fn((..._args: unknown[]) => {
    tenants.push(requestContext.getStore()?.tenantId ?? '');
    return { exec: async () => ({ upsertedCount: 1 }) };
  });
  const updateMany = jest.fn((..._args: unknown[]) => ({
    exec: async () => ({ modifiedCount: 1 }),
  }));
  const handler = new LeaverOffboardingResultHandler(
    { updateOne } as unknown as Model<OffboardingRecordDocument>,
    { updateMany } as unknown as Model<LeaverEventDocument>,
  );
  const payload: OffboardingCompletedPayload = {
    identityId: 'id-1',
    workflowId: 't-tenant-a-offboard-id-1',
    status: 'completed',
    hubStatus: 'deleted',
    systems: [{ system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' }],
  };
  const event = (tenantId: string): DomainEvent<OffboardingCompletedPayload> => ({
    eventId: 'e',
    type: DomainEventType.IDENTITY_OFFBOARDING_COMPLETED,
    aggregateId: 'id-1',
    timestamp: new Date().toISOString(),
    payload,
    metadata: { correlationId: 'c', depth: 0, emittedBy: 'test', actor: 'a', tenantId },
  });

  beforeEach(() => {
    updateOne.mockClear();
    updateMany.mockClear();
    tenants.length = 0;
  });

  it("stores every offboarding's result as the record of its workflow, in its tenant", async () => {
    await handler.handleOffboardingCompleted(event('tenant-a'));

    // Keyed by tenant and workflow only: no leaver event is needed (DELETE /identity/:id)
    expect(updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', workflowId: 't-tenant-a-offboard-id-1' },
      {
        $set: {
          identityId: 'id-1',
          status: 'completed',
          hubStatus: 'deleted',
          systems: payload.systems,
          // None: a rerun's record keeps none of an earlier run's linked admin accounts
          linkedAdmins: [],
          finishedAt: expect.any(Date),
        },
      },
      { upsert: true },
    );
    expect(tenants).toEqual(['tenant-a']);
    // The leaver event that started it (if any) no longer counts as running (HR mover)
    expect(updateMany).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-a',
        identityId: 'id-1',
        workflowId: 't-tenant-a-offboard-id-1',
        status: 'started',
      },
      { $set: { offboardingFinishedAt: expect.any(Date) } },
    );
  });

  it("stores what became of the person's linked admin accounts", async () => {
    const linkedAdmins: OffboardingCompletedPayload['linkedAdmins'] = [
      {
        identityId: 'adm-1',
        workflowId: 't-tenant-a-offboard-adm-1',
        outcome: 'failed',
        reason: 'entra: 403',
      },
    ];
    await handler.handleOffboardingCompleted({
      ...event('tenant-a'),
      payload: { ...payload, status: 'partial-failure', hubStatus: 'suspended', linkedAdmins },
    });

    expect(updateOne).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', workflowId: 't-tenant-a-offboard-id-1' },
      { $set: expect.objectContaining({ hubStatus: 'suspended', linkedAdmins }) },
      { upsert: true },
    );
  });

  it('ignores an event without a tenant', async () => {
    await handler.handleOffboardingCompleted(event(''));
    expect(updateOne).not.toHaveBeenCalled();
  });
});
