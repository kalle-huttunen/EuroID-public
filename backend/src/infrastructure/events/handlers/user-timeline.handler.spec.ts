import { UserTimelineHandler } from './user-timeline.handler';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type {
  IdentityUpdatedPayload,
  PolicyEvaluatedPayload,
  ProvisioningCompletedPayload,
  ProvisioningFailedPayload,
} from '../event-payloads';
import type { UserEventService } from '../../../modules/identity/user-event.service';
import { requestContext } from '../../middleware/correlation.middleware';

function event<T>(type: DomainEventType, aggregateId: string, payload: T): DomainEvent<T> {
  return {
    eventId: 'e1',
    type,
    aggregateId,
    timestamp: new Date().toISOString(),
    payload,
    metadata: { correlationId: 'c', depth: 0, emittedBy: 'test', actor: 'system', tenantId: 't-a' },
  } as DomainEvent<T>;
}

describe('UserTimelineHandler (the joiner history)', () => {
  const tenants: string[] = [];
  const recordEvent = jest.fn(async () => {
    tenants.push(requestContext.getStore()?.tenantId ?? '');
    return {};
  });
  const handler = new UserTimelineHandler({ recordEvent } as unknown as UserEventService);

  beforeEach(() => {
    recordEvent.mockClear();
    tenants.length = 0;
  });

  describe('policy.evaluated', () => {
    const evaluated = (payload: Partial<PolicyEvaluatedPayload>) =>
      event<PolicyEvaluatedPayload>(DomainEventType.POLICY_EVALUATED, 'id-1', {
        identityId: 'id-1',
        matchedPolicies: ['Engineering access'],
        generatedOperations: 2,
        durationMs: 5,
        forProvisioning: true,
        ...payload,
      });

    it('records the evaluation that provisioning acts on, with the policies that matched', async () => {
      await handler.handlePolicyEvaluated(evaluated({}));

      expect(recordEvent).toHaveBeenCalledWith({
        userId: 'id-1',
        type: 'POLICY_EVALUATED',
        // One entry per event: a redelivery of e1 writes none (user-event.service)
        eventId: 'e1',
        severity: 'info',
        title: 'Policy evaluated',
        description: 'Matched: Engineering access. 2 operations.',
        actor: 'system',
        metadata: { matchedPolicies: ['Engineering access'], generatedOperations: 2 },
      });
      expect(tenants).toEqual(['t-a']);
    });

    it('says so when no policy matched', async () => {
      await handler.handlePolicyEvaluated(
        evaluated({ matchedPolicies: [], generatedOperations: 0 }),
      );

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'No policy matched. 0 operations.' }),
      );
    });

    it('records nothing for a what-if evaluation or one of a profile that is no identity', async () => {
      // Simulation, anomaly scans and the access preview evaluate stored identities too
      await handler.handlePolicyEvaluated(evaluated({ forProvisioning: undefined }));
      await handler.handlePolicyEvaluated(
        event(DomainEventType.POLICY_EVALUATED, 'policy-engine', {
          matchedPolicies: ['Engineering access'],
          generatedOperations: 1,
          durationMs: 5,
          forProvisioning: true,
        } as PolicyEvaluatedPayload),
      );

      expect(recordEvent).not.toHaveBeenCalled();
    });
  });

  describe('provisioning events', () => {
    it("shows what a target that keeps no account did, from the event's detail", async () => {
      await handler.handleProvisioningCompleted(
        event<ProvisioningCompletedPayload>(DomainEventType.PROVISIONING_COMPLETED, 'id-1', {
          identityId: 'id-1',
          connector: 'file-outbound',
          operations: [],
          detail: 'no account: line appended to the outbound file',
          durationMs: 3,
        }),
      );

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'id-1',
          type: 'USER_PROVISIONED',
          title: 'Provisioned to file-outbound',
          description: 'no account: line appended to the outbound file',
          targetSystem: 'file-outbound',
        }),
      );
    });

    it('keeps the operation count for a target with an account', async () => {
      await handler.handleProvisioningCompleted(
        event<ProvisioningCompletedPayload>(DomainEventType.PROVISIONING_COMPLETED, 'id-1', {
          identityId: 'id-1',
          connector: 'entra-id',
          targetUserId: 'entra-obj-1',
          operations: [{ action: 'add', type: 'group', targetId: 'g1', success: true }],
          durationMs: 3,
        }),
      );

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ description: '1 operations executed' }),
      );
    });

    it('records nothing for an event without an identity (it is audited under its connector)', async () => {
      await handler.handleProvisioningCompleted(
        event<ProvisioningCompletedPayload>(DomainEventType.PROVISIONING_COMPLETED, 'entra-id', {
          connector: 'entra-id',
          targetUserId: 'entra-obj-1',
          operations: [],
          durationMs: 3,
        }),
      );
      await handler.handleProvisioningFailed(
        event<ProvisioningFailedPayload>(DomainEventType.PROVISIONING_FAILED, 'entra-id', {
          connector: 'entra-id',
          error: 'entra-id: 503',
          retryable: true,
        }),
      );

      expect(recordEvent).not.toHaveBeenCalled();
    });
  });

  describe('identity.updated', () => {
    const updated = (changedFields: string[]) =>
      event<IdentityUpdatedPayload>(DomainEventType.IDENTITY_UPDATED, 'id-1', {
        identityId: 'id-1',
        changedFields,
        source: 'op@corp.example',
      });

    it('records the fields an update changed, in the event tenant', async () => {
      await handler.handleIdentityUpdated(updated(['jobTitle', 'location']));

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'USER_UPDATED',
          title: 'Updated: jobTitle, location',
          description: '2 field(s) updated',
        }),
      );
      expect(tenants).toEqual(['t-a']);
    });

    // An unchanged save on the identity page wrote "Updated: " with "0 field(s) updated"
    it('records nothing for an update that changed no field', async () => {
      await handler.handleIdentityUpdated(updated([]));

      expect(recordEvent).not.toHaveBeenCalled();
    });
  });
});
