import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { AccessRequest } from '../modules/access-requests/schemas/access-request.schema';
import { AccessRequestActivities } from './access-request.activities';
import { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import { EntraEntitlementChanges } from './entra-entitlement-changes';
import { EmailNotificationService } from '../modules/notifications/email-notification.service';
import { AccessRequestSodService } from '../modules/access-requests/access-request-sod.service';
import { AccessRequestClosureService } from '../modules/access-requests/access-request-closure.service';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TEST_TENANT_ID } from '@testing/test-helpers';

describe('AccessRequestActivities', () => {
  let activities: AccessRequestActivities;
  let accessRequestModel: { findOne: jest.Mock; updateOne: jest.Mock };
  let entraChanges: { change: jest.Mock; reportRefused: jest.Mock };
  let emailNotifications: { isEnabled: jest.Mock; notifyApprover: jest.Mock };
  let accessRequestSod: { claimForProvisioning: jest.Mock; grantedElsewhere: jest.Mock };
  let closure: { close: jest.Mock };

  beforeEach(async () => {
    accessRequestModel = {
      findOne: jest.fn(),
      updateOne: jest.fn(),
    };

    entraChanges = {
      change: jest.fn().mockResolvedValue({ status: 'changed', operations: [] }),
      reportRefused: jest.fn(),
    };

    emailNotifications = {
      isEnabled: jest.fn().mockReturnValue(true),
      notifyApprover: jest.fn().mockResolvedValue('sent'),
    };

    accessRequestSod = {
      claimForProvisioning: jest.fn().mockResolvedValue({ passed: true }),
      grantedElsewhere: jest.fn().mockResolvedValue([]),
    };
    closure = { close: jest.fn().mockResolvedValue(true) };

    const module = await Test.createTestingModule({
      providers: [
        AccessRequestActivities,
        { provide: getModelToken(AccessRequest.name), useValue: accessRequestModel },
        { provide: EntitlementCatalogService, useValue: {} },
        { provide: EntraEntitlementChanges, useValue: entraChanges },
        { provide: EmailNotificationService, useValue: emailNotifications },
        { provide: AccessRequestSodService, useValue: accessRequestSod },
        { provide: AccessRequestClosureService, useValue: closure },
      ],
    }).compile();

    activities = module.get(AccessRequestActivities);
  });

  describe('getAccessRequest', () => {
    it("returns the stored request, read by its requestId in the activity's tenant", async () => {
      const doc = { requestId: 'req-1', status: 'pending' };
      let readInTenant: string | undefined;
      accessRequestModel.findOne.mockImplementation(() => {
        readInTenant = getCurrentTenantId();
        return { lean: () => ({ exec: () => Promise.resolve(doc) }) };
      });

      const result = await activities.getAccessRequest('req-1', TEST_TENANT_ID);

      expect(result).toEqual(doc);
      expect(accessRequestModel.findOne).toHaveBeenCalledWith({ requestId: 'req-1' });
      // The tenant plugin scopes the query by the context's tenant
      expect(readInTenant).toBe(TEST_TENANT_ID);
    });

    it('should return null when not found', async () => {
      accessRequestModel.findOne.mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(null) }),
      });

      const result = await activities.getAccessRequest('missing', TEST_TENANT_ID);

      expect(result).toBeNull();
    });
  });

  describe('updateRequestStatus', () => {
    it('should call updateOne', async () => {
      accessRequestModel.updateOne.mockReturnValue({ exec: () => Promise.resolve() });

      await activities.updateRequestStatus('req-1', 'approved', undefined, TEST_TENANT_ID);

      expect(accessRequestModel.updateOne).toHaveBeenCalledWith(
        { requestId: 'req-1' },
        expect.objectContaining({ $set: expect.objectContaining({ status: 'approved' }) }),
      );
    });
  });

  describe('notifyApprover', () => {
    const pending = {
      requestId: 'req-1',
      status: 'PENDING_APPROVAL',
      requesterId: 'requester-1',
      requesterEmail: 'requester@test.com',
      entitlements: [
        {
          catalogEntryId: 'cat-1',
          system: 'entra-id',
          entitlementName: 'Sales Team',
          justification: 'j',
        },
      ],
      approvalSteps: [
        {
          stepOrder: 0,
          approverType: 'MANAGER',
          approverEmail: 'manager@test.com',
          status: 'APPROVED',
        },
        {
          stepOrder: 1,
          approverType: 'OWNER',
          approverId: 'owner-1',
          approverEmail: 'owner@test.com',
          status: 'PENDING',
        },
      ],
    };
    const found = (doc: unknown) =>
      accessRequestModel.findOne.mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(doc) }),
      });

    it('emails the approver of the given step, in the workflow tenant', async () => {
      found(pending);

      await activities.notifyApprover('req-1', 1, TEST_TENANT_ID);

      expect(emailNotifications.notifyApprover).toHaveBeenCalledWith(TEST_TENANT_ID, {
        requestId: 'req-1',
        stepIndex: 1,
        stepCount: 2,
        approverEmail: 'owner@test.com',
        approverId: 'owner-1',
        requesterId: 'requester-1',
        requesterEmail: 'requester@test.com',
        entitlements: [{ system: 'entra-id', name: 'Sales Team' }],
      });
    });

    it('names the role of a ROLE step, so every holder of the role is mailed', async () => {
      const roleStep = {
        stepOrder: 1,
        approverType: 'ROLE',
        approverId: 'policy-admin',
        approverEmail: 'policy-admin',
        status: 'PENDING',
      };
      found({ ...pending, approvalSteps: [pending.approvalSteps[0], roleStep] });
      await activities.notifyApprover('req-1', 1, TEST_TENANT_ID);
      expect(emailNotifications.notifyApprover).toHaveBeenLastCalledWith(
        TEST_TENANT_ID,
        expect.objectContaining({ approverRole: 'policy-admin', stepIndex: 1 }),
      );

      // Delegated: the step belongs to the delegate, not the role
      const delegated = {
        ...roleStep,
        approverId: 'delegate-1',
        approverEmail: 'delegate@test.com',
        delegatedFrom: 'pa@test.com',
      };
      found({ ...pending, approvalSteps: [pending.approvalSteps[0], delegated] });
      await activities.notifyApprover('req-1', 1, TEST_TENANT_ID);
      const notice = emailNotifications.notifyApprover.mock.calls[1][1];
      expect(notice).toMatchObject({ approverEmail: 'delegate@test.com' });
      expect(notice.approverRole).toBeUndefined();
    });

    it('sends nothing for a decided step or a request no longer pending', async () => {
      found(pending);
      await activities.notifyApprover('req-1', 0, TEST_TENANT_ID);
      found({ ...pending, status: 'CANCELLED' });
      await activities.notifyApprover('req-1', 1, TEST_TENANT_ID);
      found(null);
      await activities.notifyApprover('missing', 0, TEST_TENANT_ID);

      expect(emailNotifications.notifyApprover).not.toHaveBeenCalled();
    });

    it('does no lookup when email is off', async () => {
      emailNotifications.isEnabled.mockReturnValue(false);

      await activities.notifyApprover('req-1', 1, TEST_TENANT_ID);

      expect(accessRequestModel.findOne).not.toHaveBeenCalled();
    });

    it('never throws, so the approval step is never held up by mail', async () => {
      found(pending);
      emailNotifications.notifyApprover.mockRejectedValue(new Error('smtp down'));
      await expect(activities.notifyApprover('req-1', 1, TEST_TENANT_ID)).resolves.toBeUndefined();

      await expect(activities.notifyApprover('req-1', 1, '')).resolves.toBeUndefined();
    });
  });

  // HX-E2: fulfilment and expiry gave provisionUserToEntra a profile built by hand, so they
  // PATCHed the person's Entra ID attributes from it (officeLocation from location, empty names)
  // and, without a recorded object id, created an account. They change the entitlement only.
  describe('provisionAccessRequest', () => {
    const request = {
      requestId: 'req-1',
      targetIdentityId: 'id-1',
      requesterId: 'id-1',
      requesterEmail: 'user@example.com',
      entitlements: [{ nativeId: 'grp-1', system: 'entra-id', entitlementType: 'Group' }],
    };
    const stored = (doc: unknown) =>
      accessRequestModel.findOne.mockReturnValue({ exec: () => Promise.resolve(doc) });
    const reasonWritten = () =>
      accessRequestModel.updateOne.mock.calls.map(([filter, update]) => ({ filter, update }));

    beforeEach(() => {
      accessRequestModel.updateOne.mockReturnValue({
        exec: () => Promise.resolve({ modifiedCount: 1 }),
      });
    });

    it("adds the entitlement on the person's recorded account, and only that", async () => {
      stored(request);

      expect(await activities.provisionAccessRequest('req-1', TEST_TENANT_ID)).toBe(true);
      expect(entraChanges.change).toHaveBeenCalledWith('id-1', [
        { type: 'group', action: 'add', targetId: 'grp-1' },
      ]);
      expect(accessRequestModel.updateOne).not.toHaveBeenCalled();
    });

    it('fails with the reason when no Entra ID account is recorded (onboarding creates it)', async () => {
      stored(request);
      entraChanges.change.mockResolvedValue({ status: 'no-account', recorded: false });

      expect(await activities.provisionAccessRequest('req-1', TEST_TENANT_ID)).toBe(false);
      expect(reasonWritten()).toEqual([
        {
          filter: { requestId: 'req-1' },
          update: {
            $set: { statusReason: expect.stringContaining('No Entra ID account is recorded') },
          },
        },
      ]);
    });

    it('fails with the reason when Entra ID no longer has the recorded account', async () => {
      stored(request);
      entraChanges.change.mockResolvedValue({ status: 'no-account', recorded: true });

      expect(await activities.provisionAccessRequest('req-1', TEST_TENANT_ID)).toBe(false);
      expect(reasonWritten()[0].update.$set.statusReason).toContain('no longer has the account');
    });

    it('fails with the reason and alerts when Graph refuses the change', async () => {
      stored(request);
      entraChanges.change.mockResolvedValue({ status: 'refused', reason: 'entra-id: refused' });

      expect(await activities.provisionAccessRequest('req-1', TEST_TENANT_ID)).toBe(false);
      expect(reasonWritten()[0].update.$set.statusReason).toContain('entra-id: refused');
      // HX-E4: the event names the request, so a subscriber can link to it
      expect(entraChanges.reportRefused).toHaveBeenCalledWith('id-1', 'entra-id: refused', 'req-1');
    });

    it('lets a failure retrying can fix reach Temporal instead of rejecting the request', async () => {
      stored(request);
      entraChanges.change.mockRejectedValue(new Error('Graph 503'));

      await expect(activities.provisionAccessRequest('req-1', TEST_TENANT_ID)).rejects.toThrow(
        'Graph 503',
      );
      expect(accessRequestModel.updateOne).not.toHaveBeenCalled();
    });

    it('returns false when the request is gone', async () => {
      stored(null);

      expect(await activities.provisionAccessRequest('req-1', TEST_TENANT_ID)).toBe(false);
      expect(entraChanges.change).not.toHaveBeenCalled();
    });
  });

  describe('revokeAccessRequest', () => {
    const request = {
      requestId: 'req-4',
      targetIdentityId: 'id-4',
      requesterId: 'id-4',
      requesterEmail: 'u@ex.com',
      entitlements: [{ nativeId: 'grp-1', system: 'entra-id', entitlementType: 'Group' }],
    };
    const stored = (doc: unknown) =>
      accessRequestModel.findOne.mockReturnValue({ exec: () => Promise.resolve(doc) });
    let modified: number;

    beforeEach(() => {
      modified = 1;
      accessRequestModel.updateOne.mockImplementation(() => ({
        exec: () => Promise.resolve({ modifiedCount: modified }),
      }));
    });

    it("removes the entitlement on the person's recorded account", async () => {
      stored(request);

      const result = await activities.revokeAccessRequest('req-4', TEST_TENANT_ID);

      expect(result).toEqual({ success: true, failedSystems: [] });
      expect(entraChanges.change).toHaveBeenCalledWith('id-4', [
        { type: 'group', action: 'remove', targetId: 'grp-1' },
      ]);
    });

    it('is done when no account is recorded, or Entra ID no longer has it', async () => {
      stored(request);
      for (const recorded of [false, true]) {
        entraChanges.change.mockResolvedValueOnce({ status: 'no-account', recorded });
        expect(await activities.revokeAccessRequest('req-4', TEST_TENANT_ID)).toEqual({
          success: true,
          failedSystems: [],
        });
      }
    });

    it('keeps the request ACTIVE with the reason and alerts once when Graph refuses', async () => {
      stored(request);
      entraChanges.change.mockResolvedValue({ status: 'refused', reason: 'entra-id: refused' });

      const first = await activities.revokeAccessRequest('req-4', TEST_TENANT_ID);
      modified = 0; // the same reason is already stored: no second alert
      const second = await activities.revokeAccessRequest('req-4', TEST_TENANT_ID);

      expect(first).toEqual({ success: false, failedSystems: ['entra-id'] });
      expect(second).toEqual({ success: false, failedSystems: ['entra-id'] });
      const [filter, update] = accessRequestModel.updateOne.mock.calls[0];
      expect(filter).toEqual({
        requestId: 'req-4',
        status: 'ACTIVE',
        statusReason: { $ne: update.$set.statusReason },
      });
      expect(update.$set.statusReason).toContain('entra-id: refused');
      expect(entraChanges.reportRefused).toHaveBeenCalledTimes(1);
      expect(entraChanges.reportRefused).toHaveBeenCalledWith('id-4', 'entra-id: refused', 'req-4');
    });

    it('clears a stored refusal once the removal succeeds', async () => {
      stored(request);

      await activities.revokeAccessRequest('req-4', TEST_TENANT_ID);

      expect(accessRequestModel.updateOne).toHaveBeenCalledWith(
        { requestId: 'req-4', status: 'ACTIVE', statusReason: { $exists: true } },
        { $unset: { statusReason: '' } },
      );
    });

    it('reports a failure retrying can fix, for the workflow to try again', async () => {
      stored(request);
      entraChanges.change.mockRejectedValue(new Error('Graph 503'));

      const result = await activities.revokeAccessRequest('req-4', TEST_TENANT_ID);

      expect(result).toEqual({ success: false, failedSystems: ['entra-id'] });
      expect(entraChanges.reportRefused).not.toHaveBeenCalled();
    });

    // Final review AG4: a removal failing on 5xx, 429 or no answer for days kept the access and
    // never reached the policy-admin removal-failing list, which needs a statusReason
    it('records that the removal is being retried, and why, so the request is listed as failing', async () => {
      stored(request);
      entraChanges.change.mockRejectedValue(new Error('Graph 503 Service Unavailable'));

      await activities.revokeAccessRequest('req-4', TEST_TENANT_ID);

      const [filter, update] = accessRequestModel.updateOne.mock.calls[0];
      expect(filter).toEqual({ requestId: 'req-4', status: 'ACTIVE' });
      expect(update.$set.statusReason).toMatch(/tried again/);
      expect(update.$set.statusReason).toContain('Graph 503 Service Unavailable');
    });

    it('should return success with empty failedSystems when doc not found', async () => {
      stored(null);

      const result = await activities.revokeAccessRequest('missing', TEST_TENANT_ID);

      expect(result).toEqual({ success: true, failedSystems: [] });
    });
  });

  describe('recheckSodBeforeProvisioning', () => {
    it('runs the claim in the workflow tenant and returns its answer', async () => {
      accessRequestSod.claimForProvisioning.mockResolvedValue({ passed: false });

      await expect(
        activities.recheckSodBeforeProvisioning('req-1', TEST_TENANT_ID),
      ).resolves.toEqual({ passed: false });
      expect(accessRequestSod.claimForProvisioning).toHaveBeenCalledWith(TEST_TENANT_ID, 'req-1');
    });

    it('refuses to run without a tenant', async () => {
      await expect(activities.recheckSodBeforeProvisioning('req-1', '')).rejects.toThrow(
        '[SECURITY]',
      );
      expect(accessRequestSod.claimForProvisioning).not.toHaveBeenCalled();
    });
  });

  describe('expireBeforeFulfilment', () => {
    it('closes a pending request EXPIRED with the reason, in the workflow tenant', async () => {
      let tenant: string | undefined;
      closure.close.mockImplementation(async () => {
        tenant = getCurrentTenantId();
        return true;
      });

      await activities.expireBeforeFulfilment('req-1', TEST_TENANT_ID);

      expect(closure.close).toHaveBeenCalledWith(
        'req-1',
        'EXPIRED',
        'The requested end date passed before approval completed.',
        'PENDING_APPROVAL',
      );
      expect(tenant).toBe(TEST_TENANT_ID);
    });

    it('refuses to run without a tenant', async () => {
      await expect(activities.expireBeforeFulfilment('req-1', '')).rejects.toThrow('[SECURITY]');
      expect(closure.close).not.toHaveBeenCalled();
    });
  });

  describe('directory roles reach Entra ID as `role` operations', () => {
    const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10';
    const roleRequest = {
      requestId: 'req-role',
      targetIdentityId: 'id-5',
      requesterId: 'id-5',
      requesterEmail: 'u@ex.com',
      entitlements: [
        { nativeId: GLOBAL_ADMIN, system: 'entra-id', entitlementType: 'DirectoryRole' },
        { nativeId: 'ENTERPRISEPACK', system: 'entra-id', entitlementType: 'License' },
      ],
    };

    beforeEach(() => {
      accessRequestModel.findOne.mockReturnValue({ exec: () => Promise.resolve(roleRequest) });
      accessRequestModel.updateOne.mockReturnValue({
        exec: () => Promise.resolve({ modifiedCount: 0 }),
      });
    });

    const sentOperations = () => entraChanges.change.mock.calls[0][1];

    it('fulfils a directory role with the operation the Entra connector handles', async () => {
      await activities.provisionAccessRequest('req-role', TEST_TENANT_ID);

      expect(sentOperations()).toEqual([
        { type: 'role', action: 'add', targetId: GLOBAL_ADMIN },
        { type: 'license', action: 'add', targetId: 'ENTERPRISEPACK' },
      ]);
    });

    it('revokes it the same way', async () => {
      await activities.revokeAccessRequest('req-role', TEST_TENANT_ID);

      expect(sentOperations()).toEqual([
        { type: 'role', action: 'remove', targetId: GLOBAL_ADMIN },
        { type: 'license', action: 'remove', targetId: 'ENTERPRISEPACK' },
      ]);
    });

    // Hunt 04 F4: the expiry removed the entitlement whatever else still granted it
    it('leaves an entitlement the person also holds through a rule or another request', async () => {
      accessRequestSod.grantedElsewhere.mockResolvedValue([roleRequest.entitlements[0]]);

      const result = await activities.revokeAccessRequest('req-role', TEST_TENANT_ID);

      expect(accessRequestSod.grantedElsewhere).toHaveBeenCalledWith(
        TEST_TENANT_ID,
        'id-5',
        'req-role',
        roleRequest.entitlements,
      );
      expect(sentOperations()).toEqual([
        { type: 'license', action: 'remove', targetId: 'ENTERPRISEPACK' },
      ]);
      expect(result).toEqual({ success: true, failedSystems: [] });
    });

    it('touches no system when everything is still granted another way', async () => {
      accessRequestSod.grantedElsewhere.mockResolvedValue(roleRequest.entitlements);

      const result = await activities.revokeAccessRequest('req-role', TEST_TENANT_ID);

      expect(entraChanges.change).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, failedSystems: [] });
    });
  });

  // Hunt 04 F4: an entitlement of a system access requests cannot fulfil was logged as not
  // supported and the request still answered true, so it ended ACTIVE with nothing granted
  describe('an entitlement of a system access requests cannot fulfil', () => {
    const mixed = {
      requestId: 'req-mixed',
      targetIdentityId: 'id-6',
      requesterId: 'id-6',
      requesterEmail: 'u@ex.com',
      entitlements: [
        { nativeId: 'grp-1', system: 'entra-id', entitlementType: 'Group' },
        { nativeId: 'CN=GG-VPN', system: 'ad', entitlementType: 'Group' },
      ],
    };

    beforeEach(() => {
      accessRequestModel.findOne.mockReturnValue({ exec: () => Promise.resolve(mixed) });
      accessRequestModel.updateOne.mockReturnValue({
        exec: () => Promise.resolve({ modifiedCount: 1 }),
      });
    });

    it('fails the fulfilment before granting any part of the request, with the reason', async () => {
      expect(await activities.provisionAccessRequest('req-mixed', TEST_TENANT_ID)).toBe(false);
      expect(entraChanges.change).not.toHaveBeenCalled();
      expect(accessRequestModel.updateOne).toHaveBeenCalledWith(
        { requestId: 'req-mixed' },
        { $set: { statusReason: expect.stringContaining('ad') } },
      );
    });
  });

  describe('tenant context rejection', () => {
    it('should throw when tenantId is empty', async () => {
      await expect(activities.getAccessRequest('req-1', '')).rejects.toThrow('[SECURITY]');
    });
  });
});
