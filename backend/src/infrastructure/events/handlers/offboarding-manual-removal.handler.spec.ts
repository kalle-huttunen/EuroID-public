import {
  OffboardingManualRemovalHandler,
  MANUAL_COMPLETION_REASON,
} from './offboarding-manual-removal.handler';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type { OffboardingTargetRemovedManuallyPayload } from '../event-payloads';
import type { IdentityService } from '../../../modules/identity/identity.service';
import { requestContext } from '../../middleware/correlation.middleware';

function event(
  offboardingComplete: boolean,
  tenantId = 'tenant-a',
): DomainEvent<OffboardingTargetRemovedManuallyPayload> {
  return {
    eventId: 'e1',
    type: DomainEventType.IDENTITY_OFFBOARDING_TARGET_REMOVED_MANUALLY,
    aggregateId: 'id-1',
    timestamp: new Date().toISOString(),
    payload: {
      identityId: 'id-1',
      leaverEventId: 'le-1',
      workflowId: 'wf-1',
      system: 'github',
      reason: 'removed by hand',
      offboardingComplete,
    },
    metadata: {
      correlationId: 'c',
      depth: 0,
      emittedBy: 'test',
      actor: 'admin@tenant-a.example',
      tenantId,
    },
  };
}

describe('OffboardingManualRemovalHandler', () => {
  const tenants: string[] = [];
  const identityService = {
    updateProvisioningState: jest.fn(async () => {
      tenants.push(requestContext.getStore()?.tenantId ?? '');
      return {};
    }),
    markAsDeleted: jest.fn(async () => ({})),
  };
  const handler = new OffboardingManualRemovalHandler(
    identityService as unknown as IdentityService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tenants.length = 0;
  });

  it('marks the target gone and keeps the Golden Record while another target is failed', async () => {
    await expect(handler.handleTargetRemovedManually(event(false))).resolves.toBe('suspended');
    expect(identityService.updateProvisioningState).toHaveBeenCalledWith(
      'id-1',
      'github',
      'DEPROVISIONED',
    );
    expect(identityService.markAsDeleted).not.toHaveBeenCalled();
    expect(tenants).toEqual(['tenant-a']);
  });

  it('deletes the Golden Record as the admin once nothing is left failed', async () => {
    await expect(handler.handleTargetRemovedManually(event(true))).resolves.toBe('deleted');
    expect(identityService.markAsDeleted).toHaveBeenCalledWith('id-1', {
      actor: 'admin@tenant-a.example',
      reason: MANUAL_COMPLETION_REASON,
    });
  });

  it('refuses an event without a tenant, so the admin request fails', async () => {
    await expect(handler.handleTargetRemovedManually(event(true, ''))).rejects.toThrow(
      'without a tenant',
    );
    expect(identityService.updateProvisioningState).not.toHaveBeenCalled();
  });

  it('passes an identity update failure to the caller', async () => {
    identityService.updateProvisioningState.mockRejectedValueOnce(new Error('db down'));
    await expect(handler.handleTargetRemovedManually(event(true))).rejects.toThrow('db down');
    expect(identityService.markAsDeleted).not.toHaveBeenCalled();
  });
});
