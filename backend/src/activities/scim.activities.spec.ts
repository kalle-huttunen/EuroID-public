import { Test } from '@nestjs/testing';
import { ScimActivities } from './scim.activities';
import { SCIMService } from '../modules/connectors/scim-connector/scim.service';
import { IdentityService } from '../modules/identity/identity.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import type { DomainEventType } from '@infrastructure/events/event-types';
import { createMockUser } from '@testing/mock-factories';
import { TEST_TENANT_ID } from '@testing/test-helpers';

const mockScimConfig = {
  baseUrl: 'https://scim.example.com',
  authType: 'bearer' as const,
  bearerToken: 'test-token',
};

describe('ScimActivities', () => {
  let activities: ScimActivities;
  let scimService: jest.Mocked<Partial<SCIMService>>;
  let eventEmitter: { emit: jest.Mock };

  beforeEach(async () => {
    scimService = {
      provision: jest.fn(),
      deprovisionUser: jest.fn(),
      healthCheck: jest.fn(),
    };

    eventEmitter = { emit: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        ScimActivities,
        { provide: SCIMService, useValue: scimService },
        { provide: IdentityService, useValue: { findIdentityById: jest.fn() } },
        { provide: DomainEventEmitterService, useValue: eventEmitter },
      ],
    }).compile();

    activities = module.get(ScimActivities);
  });

  describe('provisionUserToScim', () => {
    it('should return success with targetUserId on happy path', async () => {
      const user = createMockUser();
      (scimService.provision as jest.Mock).mockResolvedValue({
        targetUserId: 'scim-user-123',
      });

      const result = await activities.provisionUserToScim(mockScimConfig, user, TEST_TENANT_ID);

      expect(result.success).toBe(true);
      expect(result.targetUserId).toBe('scim-user-123');
    });

    it('should propagate errors for Temporal retry', async () => {
      const user = createMockUser();
      (scimService.provision as jest.Mock).mockRejectedValue(new Error('SCIM 500'));

      await expect(
        activities.provisionUserToScim(mockScimConfig, user, TEST_TENANT_ID),
      ).rejects.toThrow('SCIM 500');
    });
  });

  // Plan item: SCIM provisioning never showed as provisioned or failed on the identity timeline
  describe('provisionUserToScim events (audit log, identity timeline)', () => {
    it("emits provisioning.completed under the identity's id with the SCIM id, no email", async () => {
      (scimService.provision as jest.Mock).mockResolvedValue({ targetUserId: 'scim-user-123' });

      await activities.provisionUserToScim(mockScimConfig, createMockUser(), TEST_TENANT_ID);

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      const [type, aggregateId, payload] = eventEmitter.emit.mock.calls[0];
      expect([type, aggregateId]).toEqual(['provisioning.completed', 'test-user-id-001']);
      expect(payload).toEqual({
        identityId: 'test-user-id-001',
        connector: 'scim',
        targetUserId: 'scim-user-123',
        operations: [],
        durationMs: expect.any(Number),
      });
      expect(EVENT_SCHEMAS[type as DomainEventType]!.parse(payload)).toEqual(payload);
    });

    it('leaves out a SCIM id that is an email address (a target keyed by email)', async () => {
      (scimService.provision as jest.Mock).mockResolvedValue({
        targetUserId: 'john.doe@example.com',
      });

      await activities.provisionUserToScim(mockScimConfig, createMockUser(), TEST_TENANT_ID);

      expect(eventEmitter.emit.mock.calls[0][2]).not.toHaveProperty('targetUserId');
    });

    it('emits provisioning.failed with the email masked, and throws the masked error', async () => {
      (scimService.provision as jest.Mock).mockRejectedValue(
        new Error('userName john.doe@example.com rejected'),
      );

      const error = await activities
        .provisionUserToScim(mockScimConfig, createMockUser(), TEST_TENANT_ID)
        .catch((e: unknown) => e);

      expect((error as Error).message).toBe('scim: userName j•••@example.com rejected');
      expect(eventEmitter.emit).toHaveBeenCalledWith('provisioning.failed', 'test-user-id-001', {
        identityId: 'test-user-id-001',
        connector: 'scim',
        error: 'scim: userName j•••@example.com rejected',
        retryable: true,
      });
    });
  });

  describe('deprovisionScimUser', () => {
    it('records a removed account for the audit log under the identity, nothing when gone', async () => {
      (scimService.deprovisionUser as jest.Mock)
        .mockResolvedValueOnce({ outcome: 'deprovisioned', detail: 'deactivated' })
        .mockResolvedValueOnce({ outcome: 'already-gone', detail: 'no such user' });

      await activities.deprovisionScimUser(
        mockScimConfig,
        'ext-123',
        TEST_TENANT_ID,
        'wf',
        undefined,
        'id-1',
      );
      await activities.deprovisionScimUser(
        mockScimConfig,
        'ext-124',
        TEST_TENANT_ID,
        'wf',
        undefined,
        'id-2',
      );

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith('provisioning.deprovisioned', 'id-1', {
        identityId: 'id-1',
        connector: 'scim',
        targetUserId: 'ext-123',
        detail: 'deactivated',
      });
    });

    it('should return success when deprovision succeeds', async () => {
      (scimService.deprovisionUser as jest.Mock).mockResolvedValue({
        outcome: 'deprovisioned',
        detail: 'deactivated',
      });

      const result = await activities.deprovisionScimUser(
        mockScimConfig,
        'ext-123',
        TEST_TENANT_ID,
      );

      expect(result).toEqual({ success: true, outcome: 'deprovisioned', detail: 'deactivated' });
      expect(scimService.deprovisionUser).toHaveBeenCalledWith(mockScimConfig, {
        id: 'ext-123',
        userNames: [],
        emails: [],
      });
    });

    it('should propagate errors for Temporal retry', async () => {
      (scimService.deprovisionUser as jest.Mock).mockRejectedValue(new Error('User not found'));

      await expect(
        activities.deprovisionScimUser(mockScimConfig, 'missing', TEST_TENANT_ID),
      ).rejects.toThrow('User not found');
    });
  });

  describe('tenant context rejection', () => {
    it('should throw when tenantId is empty', async () => {
      const user = createMockUser();
      await expect(activities.provisionUserToScim(mockScimConfig, user, '')).rejects.toThrow(
        '[SECURITY]',
      );
    });
  });

  describe('checkScimHealth', () => {
    it('should return healthy when check succeeds', async () => {
      (scimService.healthCheck as jest.Mock).mockResolvedValue({ healthy: true });

      const result = await activities.checkScimHealth(mockScimConfig, TEST_TENANT_ID);

      expect(result.healthy).toBe(true);
    });

    it('should return healthy: false on error', async () => {
      (scimService.healthCheck as jest.Mock).mockRejectedValue(new Error('Connection failed'));

      const result = await activities.checkScimHealth(mockScimConfig, TEST_TENANT_ID);

      expect(result.healthy).toBe(false);
      expect(result.error).toContain('Connection failed');
    });
  });
});
