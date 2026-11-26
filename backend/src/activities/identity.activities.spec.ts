import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { IdentityActivities } from './identity.activities';
import { IdentityService } from '../modules/identity/identity.service';
import { UserEventService } from '../modules/identity/user-event.service';
import { createMockUser } from '@testing/mock-factories';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';

describe('IdentityActivities', () => {
  let activities: IdentityActivities;
  let identityService: jest.Mocked<Partial<IdentityService>>;
  let userEvents: { recordEvent: jest.Mock };

  beforeEach(async () => {
    identityService = {
      saveOrUpdateReportingCreated: jest.fn(),
      findByEmail: jest.fn(),
      findIdentityByEmail: jest.fn(),
      buildProfileWithContractsForPolicy: jest.fn(),
      getProvisionedTargetsForDeprovision: jest.fn(),
      getOffboardingTargets: jest.fn(),
      updateProvisioningState: jest.fn(),
      pushSourceAndReconcile: jest.fn(),
      markAsDeleted: jest.fn(),
      updateControls: jest.fn(),
    };

    userEvents = { recordEvent: jest.fn().mockResolvedValue({}) };

    const module = await Test.createTestingModule({
      providers: [
        IdentityActivities,
        { provide: IdentityService, useValue: identityService },
        { provide: UserEventService, useValue: userEvents },
      ],
    }).compile();

    activities = module.get(IdentityActivities);
  });

  describe('saveToHub', () => {
    it('should throw when tenantId is empty', async () => {
      const user = createMockUser();
      await expect(activities.saveToHub(user, '')).rejects.toThrow(
        '[SECURITY] tenantId is required for all activity operations',
      );
      await expect(activities.saveToHub(user, '   ')).rejects.toThrow(
        '[SECURITY] tenantId is required for all activity operations',
      );
    });

    it('should save user and return ID on happy path', async () => {
      const user = createMockUser();
      const mockRecord = { _id: { toString: () => 'id-123' } };
      (identityService.saveOrUpdateReportingCreated as jest.Mock).mockResolvedValue(mockRecord);

      const result = await activities.saveToHub(user, TEST_TENANT_ID);

      expect(identityService.saveOrUpdateReportingCreated).toHaveBeenCalledWith(user);
      expect(result).toBe('id-123');
    });

    // The national ID hash a caller computed before the start (distributed transaction,
    // bulk provisioning): the Hub save matches on it, as it would on the national ID itself
    it("hands the user's correlationId to the Hub save as its national ID hash", async () => {
      const user = { ...createMockUser(), correlationId: 'hash-1' };
      (identityService.saveOrUpdateReportingCreated as jest.Mock).mockResolvedValue({ _id: 'x' });

      await activities.saveToHub(user, TEST_TENANT_ID);

      expect(identityService.saveOrUpdateReportingCreated).toHaveBeenCalledWith(
        user,
        undefined,
        undefined,
        { nationalIdHash: 'hash-1' },
      );
    });

    it('should return mock-id when record has no _id', async () => {
      const user = createMockUser();
      (identityService.saveOrUpdateReportingCreated as jest.Mock).mockResolvedValue({});

      const result = await activities.saveToHub(user, TEST_TENANT_ID);

      expect(result).toBe('mock-id-123');
    });

    it('should propagate ConflictException when service throws', async () => {
      const user = createMockUser();
      (identityService.saveOrUpdateReportingCreated as jest.Mock).mockRejectedValue(
        new ConflictException('Duplicate key'),
      );

      await expect(activities.saveToHub(user, TEST_TENANT_ID)).rejects.toThrow(ConflictException);
    });
  });

  describe('getUserByEmail', () => {
    it('should return user when found', async () => {
      const user = createMockUser();
      const plainUser = { ...user, toObject: () => user };
      (identityService.findByEmail as jest.Mock).mockResolvedValue(plainUser);

      const result = await activities.getUserByEmail('john@example.com', TEST_TENANT_ID);

      expect(identityService.findByEmail).toHaveBeenCalledWith('john@example.com');
      expect(result).toEqual(user);
    });

    it('should return null when user not found', async () => {
      (identityService.findByEmail as jest.Mock).mockResolvedValue(null);

      const result = await activities.getUserByEmail('missing@example.com', TEST_TENANT_ID);

      expect(result).toBeNull();
    });
  });

  describe('getIdentityByEmail', () => {
    it("puts the identity's id on the policy profile, so policy and provisioning events carry it", async () => {
      const doc = {
        _id: { toString: () => 'id-1' },
        provisioning: [{ targetSystem: 'file-outbound', status: 'SYNCED' }],
      };
      (identityService.findIdentityByEmail as jest.Mock).mockResolvedValue(doc);
      (identityService.buildProfileWithContractsForPolicy as jest.Mock).mockResolvedValue({
        email: 'ada@example.com',
        departmentName: 'R&D',
      });

      await expect(
        activities.getIdentityByEmail('ada@example.com', TEST_TENANT_ID),
      ).resolves.toEqual({
        _id: 'id-1',
        profile: { _id: 'id-1', email: 'ada@example.com', departmentName: 'R&D' },
        provisioning: doc.provisioning,
      });
      expect(userEvents.recordEvent).not.toHaveBeenCalled();
    });

    // Onboarding passes the targets its health check left out as not configured (a trailing
    // argument of this call it already makes per person: no new workflow command)
    it('puts each target left out as not configured on the identity timeline, by id', async () => {
      let tenantSeen: string | undefined;
      userEvents.recordEvent.mockImplementation(async () => {
        tenantSeen = requestContext.getStore()?.tenantId;
        return {};
      });
      (identityService.findIdentityByEmail as jest.Mock).mockResolvedValue({
        _id: { toString: () => 'id-1' },
        provisioning: [],
      });
      (identityService.buildProfileWithContractsForPolicy as jest.Mock).mockResolvedValue({
        email: 'ada@example.com',
      });

      const result = await activities.getIdentityByEmail(
        'ada@example.com',
        TEST_TENANT_ID,
        'wf-1',
        ['entra'],
      );

      expect(result?._id).toBe('id-1');
      expect(userEvents.recordEvent).toHaveBeenCalledTimes(1);
      expect(userEvents.recordEvent).toHaveBeenCalledWith({
        userId: 'id-1',
        type: 'USER_PROVISIONED',
        severity: 'warning',
        title: 'Not provisioned to entra: not configured',
        description: expect.stringMatching(/no configuration/),
        actor: 'system:onboarding',
        targetSystem: 'entra',
        metadata: { workflow: 'onboarding', workflowId: 'wf-1', reason: 'not-configured' },
      });
      expect(JSON.stringify(userEvents.recordEvent.mock.calls)).not.toContain('ada@example.com');
      expect(tenantSeen).toBe(TEST_TENANT_ID);
    });

    it('still answers when the timeline write fails (the timeline is not the run)', async () => {
      userEvents.recordEvent.mockRejectedValue(new Error('timeline down'));
      (identityService.findIdentityByEmail as jest.Mock).mockResolvedValue({
        _id: { toString: () => 'id-1' },
        provisioning: [],
      });
      (identityService.buildProfileWithContractsForPolicy as jest.Mock).mockResolvedValue({});

      await expect(
        activities.getIdentityByEmail('ada@example.com', TEST_TENANT_ID, 'wf-1', ['entra']),
      ).resolves.toEqual(expect.objectContaining({ _id: 'id-1' }));
    });

    it('records nothing for an identity it does not find', async () => {
      (identityService.findIdentityByEmail as jest.Mock).mockResolvedValue(null);

      await expect(
        activities.getIdentityByEmail('ada@example.com', TEST_TENANT_ID, 'wf-1', ['entra']),
      ).resolves.toBeNull();
      expect(userEvents.recordEvent).not.toHaveBeenCalled();
    });
  });

  describe('tenant context rejection', () => {
    it('should throw [SECURITY] when getUserByEmail called with empty tenantId', async () => {
      await expect(activities.getUserByEmail('test@example.com', '')).rejects.toThrow('[SECURITY]');
    });

    it('should throw [SECURITY] when getIdentityByEmail called with empty tenantId', async () => {
      await expect(activities.getIdentityByEmail('test@example.com', '')).rejects.toThrow(
        '[SECURITY]',
      );
    });

    it('should throw [SECURITY] when getProvisionedTargets called with empty tenantId', async () => {
      await expect(activities.getProvisionedTargets('id-123', '')).rejects.toThrow('[SECURITY]');
    });

    it('returns the offboarding targets of the identity in its tenant', async () => {
      const found = { noProvisioningState: false, targets: [] };
      (identityService.getOffboardingTargets as jest.Mock).mockResolvedValue(found);

      await expect(activities.getOffboardingTargets('id-123', TEST_TENANT_ID)).resolves.toBe(found);
      expect(identityService.getOffboardingTargets).toHaveBeenCalledWith('id-123', TEST_TENANT_ID);
      await expect(activities.getOffboardingTargets('id-123', '')).rejects.toThrow('[SECURITY]');
    });
  });

  describe('suspendIdentity (offboarding with a failed target)', () => {
    it('disables the login so reconciliation keeps the Golden Record SUSPENDED', async () => {
      (identityService.updateControls as jest.Mock).mockResolvedValue({ _id: 'id-1' });

      await activities.suspendIdentity('id-1', TEST_TENANT_ID);

      // The audit entry of the kill switch names offboarding as the actor
      expect(identityService.updateControls).toHaveBeenCalledWith(
        'id-1',
        { isLoginDisabled: true },
        'offboarding-workflow',
      );
    });

    it('fails when the identity does not exist, so the workflow does not report it updated', async () => {
      (identityService.updateControls as jest.Mock).mockResolvedValue(null);

      await expect(activities.suspendIdentity('missing', TEST_TENANT_ID)).rejects.toThrow(
        /no identity missing/,
      );
    });
  });

  describe('setProvisioningStatus and the access baseline', () => {
    const tenants: string[] = [];
    beforeEach(() => {
      tenants.length = 0;
      identityService.recordInitialAccessBaseline = jest.fn(async () => {
        tenants.push(requestContext.getStore()?.tenantId ?? '');
        return true;
      });
    });

    it('records the first baseline in the tenant when a target becomes SYNCED', async () => {
      await activities.setProvisioningStatus(
        'id-1',
        'entra-id',
        'SYNCED',
        undefined,
        TEST_TENANT_ID,
      );

      expect(identityService.updateProvisioningState).toHaveBeenCalled();
      expect(identityService.recordInitialAccessBaseline).toHaveBeenCalledWith('id-1');
      expect(tenants).toEqual([TEST_TENANT_ID]);
    });

    it('records none for other states', async () => {
      for (const status of ['SYNCING', 'ERROR', 'DEPROVISIONED'] as const) {
        await activities.setProvisioningStatus(
          'id-1',
          'entra-id',
          status,
          undefined,
          TEST_TENANT_ID,
        );
      }
      expect(identityService.recordInitialAccessBaseline).not.toHaveBeenCalled();
    });

    it('still sets the state when the baseline cannot be written', async () => {
      (identityService.recordInitialAccessBaseline as jest.Mock).mockRejectedValue(
        new Error('write conflict'),
      );

      await expect(
        activities.setProvisioningStatus('id-1', 'ad', 'SYNCED', undefined, TEST_TENANT_ID),
      ).resolves.toBeUndefined();
      expect(identityService.updateProvisioningState).toHaveBeenCalled();
    });
  });

  describe('recordOnboardingBlocked (a BLOCK SoD policy refused the person)', () => {
    it('puts the refusal and its reason on the identity timeline, in the run tenant', async () => {
      let tenantSeen: string | undefined;
      userEvents.recordEvent.mockImplementation(async () => {
        tenantSeen = requestContext.getStore()?.tenantId;
        return {};
      });

      await activities.recordOnboardingBlocked(
        'id-1',
        'Segregation of Duties conflict: Payments vs approvals',
        TEST_TENANT_ID,
        'wf-1',
      );

      expect(userEvents.recordEvent).toHaveBeenCalledWith({
        userId: 'id-1',
        type: 'WORKFLOW_COMPLETED',
        severity: 'error',
        title: 'Onboarding refused by a segregation of duties policy',
        description:
          'Segregation of Duties conflict: Payments vs approvals. No target was changed.',
        actor: 'system:onboarding',
        metadata: { workflow: 'onboarding', workflowId: 'wf-1' },
      });
      expect(tenantSeen).toBe(TEST_TENANT_ID);
      expect(identityService.updateProvisioningState).not.toHaveBeenCalled();
    });

    it('refuses to run without a tenant', async () => {
      await expect(activities.recordOnboardingBlocked('id-1', 'x', '')).rejects.toThrow(
        '[SECURITY]',
      );
      expect(userEvents.recordEvent).not.toHaveBeenCalled();
    });
  });

  describe('recordAdminAccountFailed (an admin account child of onboarding failed)', () => {
    it('puts each failed tier with its reason on the timeline, emails masked, in the run tenant', async () => {
      let tenantSeen: string | undefined;
      userEvents.recordEvent.mockImplementation(async () => {
        tenantSeen = requestContext.getStore()?.tenantId;
        return {};
      });

      await activities.recordAdminAccountFailed(
        'id-1',
        [
          {
            adminTier: 'TIER_2',
            reason: 'The admin UPN is taken: put {tier} in ADMIN_UPN_PATTERN',
          },
          { adminTier: 'TIER_0', reason: 'Graph refused adm-ada@example.com' },
        ],
        TEST_TENANT_ID,
        'wf-1',
      );

      expect(userEvents.recordEvent).toHaveBeenCalledWith({
        userId: 'id-1',
        type: 'WORKFLOW_COMPLETED',
        severity: 'error',
        title: 'Admin account not provisioned',
        description:
          'TIER_2: The admin UPN is taken: put {tier} in ADMIN_UPN_PATTERN; TIER_0: Graph ' +
          "refused a•••@example.com. The person's own accounts were provisioned; the next " +
          'onboarding run provisions the admin account again.',
        actor: 'system:onboarding',
        metadata: { workflow: 'onboarding', workflowId: 'wf-1' },
      });
      expect(tenantSeen).toBe(TEST_TENANT_ID);
    });

    it('refuses to run without a tenant', async () => {
      await expect(activities.recordAdminAccountFailed('id-1', [], '')).rejects.toThrow(
        '[SECURITY]',
      );
      expect(userEvents.recordEvent).not.toHaveBeenCalled();
    });
  });
});
