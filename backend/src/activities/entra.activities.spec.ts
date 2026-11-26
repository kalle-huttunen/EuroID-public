import { ApplicationFailure } from '@temporalio/common';
import { HttpStatus } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { Test } from '@nestjs/testing';
import { EntraActivities } from './entra.activities';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import type { EntraConfig } from '../modules/connectors/entra-connector/entra.interface';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import { EntitlementCatalogService } from '../modules/entitlement-catalog/entitlement-catalog.service';
import { IdentityService } from '../modules/identity/identity.service';
import { createMockUser } from '@testing/mock-factories';
import { createMockEventEmitter } from '@testing/test-helpers';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';

describe('EntraActivities', () => {
  let activities: EntraActivities;
  let entraService: jest.Mocked<Partial<EntraService>>;
  let eventEmitter: ReturnType<typeof createMockEventEmitter>;
  let identityService: { findIdentityById: jest.Mock };

  beforeEach(async () => {
    entraService = {
      provision: jest.fn(),
      checkConnection: jest.fn(),
      deleteUser: jest.fn(),
    };
    eventEmitter = createMockEventEmitter();
    identityService = { findIdentityById: jest.fn().mockResolvedValue(null) };

    const module = await Test.createTestingModule({
      providers: [
        EntraActivities,
        { provide: EntraService, useValue: entraService },
        { provide: DomainEventEmitterService, useValue: eventEmitter },
        { provide: EntitlementCatalogService, useValue: { absorbDiscovered: jest.fn() } },
        { provide: IdentityService, useValue: identityService },
      ],
    }).compile();

    activities = module.get(EntraActivities);
  });

  describe('provisionUserToEntra', () => {
    it('should return success with objectId on happy path', async () => {
      const user = createMockUser();
      (entraService.provision as jest.Mock).mockResolvedValue({
        targetUserId: 'entra-obj-123',
        generatedAttributes: { mail: 'john@example.com' },
      });

      const result = await activities.provisionUserToEntra(
        user,
        undefined,
        undefined,
        TEST_TENANT_ID,
      );

      expect(result.success).toBe(true);
      expect(result.objectId).toBe('entra-obj-123');
      expect(result.skipped).toBe(false);
    });

    it('should propagate errors for Temporal retry', async () => {
      const user = createMockUser();
      (entraService.provision as jest.Mock).mockRejectedValue(new Error('Network error'));

      await expect(
        activities.provisionUserToEntra(user, undefined, undefined, TEST_TENANT_ID),
      ).rejects.toThrow('Network error');
    });

    describe('its provisioning events (audit log, timeline, websocket)', () => {
      const emitted = (type: DomainEventType) => {
        const calls = (eventEmitter.emit as jest.Mock).mock.calls.filter(([t]) => t === type);
        expect(calls).toHaveLength(1);
        const [, aggregateId, payload] = calls[0] as [string, string, Record<string, unknown>];
        // The emitter validates the payload against its schema
        expect(EVENT_SCHEMAS[type]!.parse(payload)).toEqual(payload);
        return { aggregateId, payload };
      };

      beforeEach(() => {
        (entraService.provision as jest.Mock).mockResolvedValue({
          targetUserId: 'entra-obj-123',
          generatedAttributes: {
            mail: 'john.doe@corp.test',
            userPrincipalName: 'john.doe@corp.test',
          },
        });
      });

      it("go under the identity's id, without the generated mail or UPN", async () => {
        await activities.provisionUserToEntra(
          createMockUser({ _id: 'id-1' }),
          undefined,
          undefined,
          TEST_TENANT_ID,
        );

        const { aggregateId, payload } = emitted(DomainEventType.PROVISIONING_COMPLETED);
        expect(aggregateId).toBe('id-1');
        expect(payload).toEqual({
          identityId: 'id-1',
          connector: 'entra-id',
          targetUserId: 'entra-obj-123',
          operations: [],
          durationMs: expect.any(Number),
        });
      });

      it('go under the connector, with no identity id and no email, for a profile without an id', async () => {
        await activities.provisionUserToEntra(
          createMockUser({ _id: undefined }),
          undefined,
          undefined,
          TEST_TENANT_ID,
        );

        const { aggregateId, payload } = emitted(DomainEventType.PROVISIONING_COMPLETED);
        expect(aggregateId).toBe('entra-id');
        expect(payload).not.toHaveProperty('identityId');
        expect(JSON.stringify(payload)).not.toContain('@');
      });

      it('report a failure the same way', async () => {
        (entraService.provision as jest.Mock).mockRejectedValue(
          new Error('Graph refused john.doe@example.com'),
        );

        await expect(
          activities.provisionUserToEntra(
            createMockUser({ _id: undefined }),
            undefined,
            undefined,
            TEST_TENANT_ID,
          ),
        ).rejects.toThrow();

        const { aggregateId, payload } = emitted(DomainEventType.PROVISIONING_FAILED);
        expect(aggregateId).toBe('entra-id');
        expect(payload).not.toHaveProperty('identityId');
        expect(JSON.stringify(payload)).not.toContain('john.doe@example.com');
      });
    });
  });

  // Plan item: an identity whose Entra UPN was renamed got a second account from a mover run
  describe("provisionUserToEntra on the identity's written-back object id", () => {
    const identityId = '65a1b2c3d4e5f60718293a4b';
    const identity = (entry?: Record<string, unknown>) => ({
      sources: [
        { sourceName: 'HR', sourceRole: 'primary-hr', externalId: 'E-1' },
        { sourceName: 'entra-id', sourceRole: 'target', externalId: 'entra-obj-7' },
      ],
      provisioning: entry ? [{ targetSystem: 'entra-id', ...entry }] : [],
    });
    const provision = (accountId?: string) =>
      activities.provisionUserToEntra(
        createMockUser({ _id: identityId }),
        undefined,
        undefined,
        TEST_TENANT_ID,
        'wf-1',
        accountId,
      );

    beforeEach(() => {
      (entraService.provision as jest.Mock).mockResolvedValue({ targetUserId: 'entra-obj-7' });
    });

    it.each([
      ['SYNCED', { status: 'SYNCED', provisionedAt: new Date() }, 'entra-obj-7'],
      ['ERROR with the created account written back', { status: 'ERROR' }, 'entra-obj-7'],
      ['SYNCING in a later run', { status: 'SYNCING', provisionedAt: new Date() }, 'entra-obj-7'],
      ['missing (an adopted account)', undefined, 'entra-obj-7'],
      ['DEPROVISIONED', { status: 'DEPROVISIONED', provisionedAt: null }, undefined],
      ['SYNCING after a deprovision', { status: 'SYNCING', provisionedAt: null }, undefined],
    ])('finds the account by it when the Entra ID entry is %s', async (_e, entry, expected) => {
      identityService.findIdentityById.mockResolvedValue(identity(entry));

      await provision();

      expect(identityService.findIdentityById).toHaveBeenCalledWith(identityId);
      expect(entraService.provision).toHaveBeenCalledWith(
        expect.objectContaining({ _id: identityId }),
        undefined,
        undefined,
        expected,
        false,
      );
    });

    it('takes the id a caller already read (the mover) without reading the identity', async () => {
      await provision('entra-obj-9');

      expect(identityService.findIdentityById).not.toHaveBeenCalled();
      expect(entraService.provision).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        undefined,
        'entra-obj-9',
        false,
      );
    });

    it('fails without retry when Entra ID no longer has that account', async () => {
      identityService.findIdentityById.mockResolvedValue(identity({ status: 'SYNCED' }));
      (entraService.provision as jest.Mock).mockRejectedValue(
        new ConnectorException(
          'No Entra ID account has the object id recorded for the identity (entra-obj-7)',
          HttpStatus.UNPROCESSABLE_ENTITY,
        ),
      );

      const error = await provision().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(true);
      expect((error as Error).message).toContain('No Entra ID account has the object id');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.PROVISIONING_FAILED,
        identityId,
        expect.objectContaining({ retryable: false }),
      );
    });
  });

  // A distributed-transaction CREATE (HX-F2 follow-up): create only, under the UPN its prepare
  // resolved, never on an account the identity or the UPN lookup finds
  describe('provisionUserToEntra with a UPN to create the account under (createAs)', () => {
    it('creates the account under that UPN through createAccount, reading no identity', async () => {
      entraService.createAccount = jest.fn().mockResolvedValue({
        targetUserId: 'entra-obj-new',
        upnResolution: { chosenUpn: 'ada.l2@corp.test', candidatesChecked: ['ada.l2@corp.test'] },
      });
      const user = createMockUser({ _id: '65a1b2c3d4e5f60718293a4b' });

      const result = await activities.provisionUserToEntra(
        user,
        undefined,
        undefined,
        TEST_TENANT_ID,
        'wf-1',
        undefined,
        undefined,
        'ada.l2@corp.test',
      );

      expect(entraService.createAccount).toHaveBeenCalledWith(
        user,
        'ada.l2@corp.test',
        undefined,
        undefined,
      );
      expect(entraService.provision).not.toHaveBeenCalled();
      expect(identityService.findIdentityById).not.toHaveBeenCalled();
      expect(result.objectId).toBe('entra-obj-new');
    });
  });

  // An identity with an Entra ID account but no written-back object id (bulk provisioning writes
  // none) got a second account from the mover or a syncToEntra edit (FOLLOWUPS 2026-11-24)
  describe('provisionUserToEntra for the mover and a sync (mustExist)', () => {
    const identityId = '65a1b2c3d4e5f60718293a4b';
    const withEntry = (entry?: Record<string, unknown>) => ({
      sources: [{ sourceName: 'HR', sourceRole: 'primary-hr', externalId: 'E-1' }],
      provisioning: entry ? [{ targetSystem: 'entra-id', ...entry }] : [],
    });
    const provision = () =>
      activities.provisionUserToEntra(
        createMockUser({ _id: identityId }),
        undefined,
        undefined,
        TEST_TENANT_ID,
        'wf-1',
        undefined,
        true,
      );

    beforeEach(() => {
      (entraService.provision as jest.Mock).mockResolvedValue({ targetUserId: 'entra-obj-3' });
    });

    it.each([
      ['SYNCED', { status: 'SYNCED' }],
      ['SYNCING after SYNCED', { status: 'SYNCING', provisionedAt: new Date() }],
      ['ERROR after a completed writeback', { status: 'ERROR', writebackComplete: true }],
    ])('asks for the existing account when the Entra ID entry is %s', async (_e, entry) => {
      identityService.findIdentityById.mockResolvedValue(withEntry(entry));

      await provision();

      expect(entraService.provision).toHaveBeenCalledWith(
        expect.objectContaining({ _id: identityId }),
        undefined,
        undefined,
        undefined,
        true,
      );
    });

    it.each([
      ['missing (no account yet)', undefined],
      ['PENDING', { status: 'PENDING' }],
      ['DEPROVISIONED', { status: 'DEPROVISIONED', provisionedAt: null }],
    ])('lets provisioning create the account when the entry is %s', async (_e, entry) => {
      identityService.findIdentityById.mockResolvedValue(withEntry(entry));

      await provision();

      expect(entraService.provision).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        undefined,
        undefined,
        false,
      );
    });

    it('fails without retry when no account has the identifiers', async () => {
      identityService.findIdentityById.mockResolvedValue(withEntry({ status: 'SYNCED' }));
      (entraService.provision as jest.Mock).mockRejectedValue(
        new ConnectorException(
          'The Entra ID account of this identity was not found: no object id is recorded for it',
          HttpStatus.UNPROCESSABLE_ENTITY,
        ),
      );

      const error = await provision().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).nonRetryable).toBe(true);
      expect((error as Error).message).toContain('The Entra ID account of this identity');
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.PROVISIONING_FAILED,
        identityId,
        expect.objectContaining({ retryable: false }),
      );
    });
  });

  describe('checkEntraHealth', () => {
    it('should return true when connection succeeds', async () => {
      (entraService.checkConnection as jest.Mock).mockResolvedValue(true);

      const result = await activities.checkEntraHealth(undefined, TEST_TENANT_ID);

      expect(result).toBe(true);
    });

    it('should return false when connection fails', async () => {
      (entraService.checkConnection as jest.Mock).mockRejectedValue(new Error('Auth failed'));

      const result = await activities.checkEntraHealth(undefined, TEST_TENANT_ID);

      expect(result).toBe(false);
    });
  });

  describe('isEntraConfigured (onboarding leaves an unconfigured Entra ID out of the run)', () => {
    const canvas = { tenantId: 'entra-canvas', clientId: 'app-c', clientSecret: 's-c' };

    it("answers for the caller's config in the tenant's context", async () => {
      let seenTenant: string | undefined;
      entraService.isConfiguredFor = jest.fn(async () => {
        // The installed connector config is read for the tenant of the request context
        seenTenant = getRequestContext()?.tenantId;
        return false;
      });

      await expect(activities.isEntraConfigured(canvas, TEST_TENANT_ID, 'wf-1')).resolves.toBe(
        false,
      );
      expect(entraService.isConfiguredFor).toHaveBeenCalledWith(canvas);
      expect(seenTenant).toBe(TEST_TENANT_ID);
    });

    it('lets a failed config read fail the activity, for Temporal to retry', async () => {
      entraService.isConfiguredFor = jest.fn().mockRejectedValue(new Error('Mongo unavailable'));

      await expect(activities.isEntraConfigured(undefined, TEST_TENANT_ID)).rejects.toThrow(
        'Mongo unavailable',
      );
    });

    it('refuses a call without a tenant', async () => {
      entraService.isConfiguredFor = jest.fn().mockResolvedValue(true);

      await expect(activities.isEntraConfigured(undefined, '')).rejects.toThrow('[SECURITY]');
      expect(entraService.isConfiguredFor).not.toHaveBeenCalled();
    });
  });

  describe('deleteUser (offboarding)', () => {
    it('reports a deleted user as deprovisioned, by the id it was given', async () => {
      (entraService.deleteUser as jest.Mock).mockResolvedValue(true);

      await expect(
        activities.deleteUser('entra-obj-1', undefined, 'id-1', TEST_TENANT_ID),
      ).resolves.toEqual({ success: true, outcome: 'deprovisioned' });
      expect(entraService.deleteUser).toHaveBeenCalledWith('entra-obj-1', undefined);
    });

    // A deletion is no provisioning (no provisioning.completed, which the timeline showed as
    // "Provisioned"); it is audited as provisioning.deprovisioned, with ids only. Offboarding,
    // expiry and access review write the timeline entry themselves; orphan cleanup and bulk
    // delete remove accounts of no identity.
    it.each([
      [
        'by object id',
        'entra-obj-1',
        'id-1',
        false,
        'id-1',
        { identityId: 'id-1', targetUserId: 'entra-obj-1' },
      ],
      ['by email', 'ada@example.com', 'id-1', true, 'id-1', { identityId: 'id-1' }],
      [
        'without an identity (bulk delete, orphans)',
        'ada@example.com',
        undefined,
        undefined,
        'entra-id',
        {},
      ],
    ])(
      'records a deletion %s for the audit log, with ids only',
      async (_how, who, identityId, byEmail, aggregateId, ids) => {
        (entraService.deleteUser as jest.Mock).mockResolvedValue(true);

        await activities.deleteUser(who, undefined, identityId, TEST_TENANT_ID, 'wf', byEmail);

        expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
        const [type, aggregate, payload] = (eventEmitter.emit as jest.Mock).mock.calls[0];
        expect(type).toBe(DomainEventType.PROVISIONING_DEPROVISIONED);
        expect(aggregate).toBe(aggregateId);
        expect(payload).toEqual({ ...ids, connector: 'entra-id', detail: 'deleted' });
        expect(JSON.stringify(payload)).not.toContain('@');
        expect(EVENT_SCHEMAS[DomainEventType.PROVISIONING_DEPROVISIONED]!.parse(payload)).toEqual(
          payload,
        );
      },
    );

    it('reports a user Graph no longer has (404) as already gone, with no event', async () => {
      (entraService.deleteUser as jest.Mock).mockResolvedValue(false);

      await expect(
        activities.deleteUser('ada@example.com', undefined, 'id-1', TEST_TENANT_ID),
      ).resolves.toEqual({ success: true, outcome: 'already-gone' });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    describe('without a stored object id (byEmail)', () => {
      it('finds a user whose UPN is not the email by mail and deletes it by id', async () => {
        (entraService.deleteUser as jest.Mock)
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true);
        entraService.getUserByEmail = jest.fn().mockResolvedValue({ id: 'entra-obj-9' });

        await expect(
          activities.deleteUser('ada@example.com', undefined, 'id-1', TEST_TENANT_ID, 'wf', true),
        ).resolves.toEqual({ success: true, outcome: 'deprovisioned' });
        expect(entraService.getUserByEmail).toHaveBeenCalledWith('ada@example.com', undefined);
        expect(entraService.deleteUser).toHaveBeenLastCalledWith('entra-obj-9', undefined);
      });

      it('masks the email in a Graph failure reason and fails a client error at once', async () => {
        (entraService.deleteUser as jest.Mock).mockRejectedValue(
          Object.assign(new Error("Invalid object identifier 'ada@example.com'"), {
            response: { status: 400 },
          }),
        );

        const error = await activities
          .deleteUser('ada@example.com', undefined, 'id-1', TEST_TENANT_ID, 'wf', false)
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ApplicationFailure);
        expect((error as ApplicationFailure).nonRetryable).toBe(true);
        expect((error as Error).message).toContain("'a•••@example.com'");
        expect((error as Error).message).not.toContain('ada@example.com');
      });

      it('fails without retry, for an admin to check, when no user has the email', async () => {
        (entraService.deleteUser as jest.Mock).mockResolvedValue(false);
        entraService.getUserByEmail = jest.fn().mockResolvedValue(null);

        const error = await activities
          .deleteUser('ada@example.com', undefined, 'id-1', TEST_TENANT_ID, 'wf', true)
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ApplicationFailure);
        expect((error as ApplicationFailure).nonRetryable).toBe(true);
        expect((error as Error).message).toContain('mark it removed manually');
        expect(entraService.deleteUser).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('tenant context rejection', () => {
    it('should throw when tenantId is empty', async () => {
      const user = createMockUser();
      await expect(activities.provisionUserToEntra(user, undefined, undefined, '')).rejects.toThrow(
        '[SECURITY]',
      );
    });
  });
  describe('enableEntraUser and disableEntraUser (a privileged session)', () => {
    const canvas = { tenantId: 'canvas-tenant' } as unknown as EntraConfig;

    it('runs on the config the session passes, by the stored object id', async () => {
      entraService.checkUserExists = jest.fn().mockResolvedValue('obj-adm');
      entraService.enableUser = jest.fn().mockResolvedValue(true);
      entraService.disableUser = jest.fn().mockResolvedValue(true);

      await expect(
        activities.enableEntraUser('obj-adm', TEST_TENANT_ID, 'wf-1', canvas),
      ).resolves.toBe(true);
      await expect(
        activities.disableEntraUser('obj-adm', TEST_TENANT_ID, 'wf-1', canvas),
      ).resolves.toBe(true);

      expect(entraService.checkUserExists).toHaveBeenCalledWith('obj-adm', canvas);
      expect(entraService.enableUser).toHaveBeenCalledWith('obj-adm', canvas);
      expect(entraService.disableUser).toHaveBeenCalledWith('obj-adm', canvas);
    });

    it('answers false for an account Entra ID does not know', async () => {
      entraService.checkUserExists = jest.fn().mockResolvedValue(null);
      entraService.enableUser = jest.fn();
      await expect(activities.enableEntraUser('gone', TEST_TENANT_ID, 'wf-1')).resolves.toBe(false);
      expect(entraService.enableUser).not.toHaveBeenCalled();
    });
  });
});
