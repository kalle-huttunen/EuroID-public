import { MockActivityEnvironment } from '@temporalio/testing';
import { Test } from '@nestjs/testing';
import {
  ORPHAN_DETECTION_HEARTBEAT_MS,
  ReconciliationActivities,
} from './reconciliation.activities';
import { IdentityService } from '../modules/identity/identity.service';
import { EntraActivities } from './entra.activities';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { AdService } from '../modules/connectors/ad-connector/ad.service';
import { SCIMService } from '../modules/connectors/scim-connector/scim.service';
import { ConnectorConfigService } from '../modules/connectors/connector-config.service';
import { ConnectorConfigDecryptError } from '../modules/connectors/connector-config.errors';
import { OrphanDetectionService } from '../modules/reconciliation/orphan-detection.service';
import { DriftService } from '../modules/reconciliation/drift.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EmailNotificationService } from '../modules/notifications/email-notification.service';
import { createMockEventEmitter } from '@testing/test-helpers';
import { createMockUser } from '@testing/mock-factories';
import { TEST_TENANT_ID } from '@testing/test-helpers';
import { DriftType } from '@shared/dtos/distributed-transaction.dto';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { driftThresholdAlerts } from '../workflows/reconciliation-alerts';

describe('ReconciliationActivities', () => {
  let activities: ReconciliationActivities;
  let identityService: jest.Mocked<Partial<IdentityService>>;
  let entraActivities: jest.Mocked<Partial<EntraActivities>>;
  let entraService: jest.Mocked<Partial<EntraService>>;
  let eventEmitter: ReturnType<typeof createMockEventEmitter>;
  let mockConnectorConfig: { getConfig: jest.Mock };
  let adService: { getUserByEmail: jest.Mock; setUserEnabled: jest.Mock };
  let scimService: { getUserByEmail: jest.Mock; setActive: jest.Mock };
  let driftService: { recordDetection: jest.Mock; closeCorrectedDrift: jest.Mock };
  let emailNotifications: { notifyDriftThreshold: jest.Mock };

  beforeEach(async () => {
    identityService = {
      findUsersPageForReconciliation: jest.fn(),
      // The stored identity a correction re-reads: the mock user, unless a test says otherwise
      findUserForReconciliation: jest.fn().mockImplementation(async () => createMockUser()),
    };

    entraActivities = {
      provisionUserToEntra: jest.fn().mockResolvedValue({ success: true }),
      disableEntraUser: jest.fn().mockResolvedValue(true),
      enableEntraUser: jest.fn().mockResolvedValue(true),
    };

    entraService = {
      getUserByEmail: jest.fn().mockResolvedValue(null),
    };

    mockConnectorConfig = { getConfig: jest.fn().mockResolvedValue(null) };
    adService = { getUserByEmail: jest.fn(), setUserEnabled: jest.fn() };
    scimService = { getUserByEmail: jest.fn(), setActive: jest.fn() };
    driftService = {
      recordDetection: jest.fn().mockResolvedValue(undefined),
      closeCorrectedDrift: jest.fn().mockResolvedValue(undefined),
    };
    eventEmitter = createMockEventEmitter();
    emailNotifications = { notifyDriftThreshold: jest.fn().mockResolvedValue('sent') };

    const module = await Test.createTestingModule({
      providers: [
        ReconciliationActivities,
        { provide: IdentityService, useValue: identityService },
        { provide: EntraActivities, useValue: entraActivities },
        { provide: EntraService, useValue: entraService },
        { provide: AdService, useValue: adService },
        { provide: SCIMService, useValue: scimService },
        { provide: ConnectorConfigService, useValue: mockConnectorConfig },
        { provide: OrphanDetectionService, useValue: {} },
        { provide: DriftService, useValue: driftService },
        { provide: DomainEventEmitterService, useValue: eventEmitter },
        { provide: EmailNotificationService, useValue: emailNotifications },
      ],
    }).compile();

    activities = module.get(ReconciliationActivities);
  });

  describe('getReconciliationUserCount', () => {
    it('should return total from findUsersPageForReconciliation', async () => {
      (identityService.findUsersPageForReconciliation as jest.Mock).mockResolvedValue({
        users: [{}],
        total: 150,
      });

      const result = await activities.getReconciliationUserCount(TEST_TENANT_ID);

      expect(result).toBe(150);
    });

    it('should return 0 when total is undefined', async () => {
      (identityService.findUsersPageForReconciliation as jest.Mock).mockResolvedValue({
        users: [],
      });

      const result = await activities.getReconciliationUserCount(TEST_TENANT_ID);

      expect(result).toBe(0);
    });

    it("counts the run's scan scope only, with the filter every page uses", async () => {
      (identityService.findUsersPageForReconciliation as jest.Mock).mockResolvedValue({
        users: [{}],
        total: 12,
      });
      const scope = { includedDepartments: ['Sales'], excludedUsers: ['ceo@example.com'] };

      await expect(activities.getReconciliationUserCount(TEST_TENANT_ID, scope)).resolves.toBe(12);
      expect(identityService.findUsersPageForReconciliation).toHaveBeenCalledWith(0, 1, scope);
    });
  });

  describe('getReconciliationBatchConfig', () => {
    it('should return batchCount and batchSize', async () => {
      const result = await activities.getReconciliationBatchConfig();

      expect(result).toHaveProperty('batchCount');
      expect(result).toHaveProperty('batchSize');
      expect(typeof result.batchCount).toBe('number');
      expect(typeof result.batchSize).toBe('number');
    });
  });

  describe('getReconciliationBatchPlan', () => {
    it('should return batches for totalUsers', async () => {
      const result = await activities.getReconciliationBatchPlan(TEST_TENANT_ID, 100);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('skip');
      expect(result[0]).toHaveProperty('limit');
      expect(result[0]).toHaveProperty('index');
    });

    it('should return empty array when totalUsers is 0', async () => {
      const result = await activities.getReconciliationBatchPlan(TEST_TENANT_ID, 0);

      expect(result).toEqual([]);
    });
  });

  describe('getWorkflowStartTime', () => {
    it('should return a Date', async () => {
      const result = await activities.getWorkflowStartTime();

      expect(result).toBeInstanceOf(Date);
    });
  });

  describe('fetchHubUsersPage', () => {
    it('should return users and nextPageToken from identityService', async () => {
      const users = [createMockUser()];
      (identityService.findUsersPageForReconciliation as jest.Mock).mockResolvedValue({
        users,
        total: 1,
      });

      const result = await activities.fetchHubUsersPage(TEST_TENANT_ID, '0', 100);

      expect(result.users).toHaveLength(1);
      expect(result.nextPageToken).toBeNull();
      expect(identityService.findUsersPageForReconciliation).toHaveBeenCalledWith(0, 100);
    });

    /**
     * One activity result holds the page: up to 5000 identities with their whole profile and
     * metadata were several MB, over Temporal's payload limit, and the batch failed (r2-05 N2).
     */
    it('fetches at most RECONCILIATION_PAGE_SIZE identities, so the next page follows', async () => {
      const previous = process.env.RECONCILIATION_PAGE_SIZE;
      process.env.RECONCILIATION_PAGE_SIZE = '2';
      try {
        (identityService.findUsersPageForReconciliation as jest.Mock).mockResolvedValue({
          users: [createMockUser(), createMockUser()],
        });

        const result = await activities.fetchHubUsersPage(TEST_TENANT_ID, '10', 5000);

        expect(identityService.findUsersPageForReconciliation).toHaveBeenCalledWith(10, 2);
        expect(result.nextPageToken).toBe('12');
      } finally {
        if (previous === undefined) delete process.env.RECONCILIATION_PAGE_SIZE;
        else process.env.RECONCILIATION_PAGE_SIZE = previous;
      }
    });

    it('defaults to pages of 200 identities', async () => {
      (identityService.findUsersPageForReconciliation as jest.Mock).mockResolvedValue({
        users: [],
      });

      await activities.fetchHubUsersPage(TEST_TENANT_ID, '0', 5000);

      expect(identityService.findUsersPageForReconciliation).toHaveBeenCalledWith(0, 200);
    });

    it('returns only what drift detection reads of each identity', async () => {
      (identityService.findUsersPageForReconciliation as jest.Mock).mockResolvedValue({
        users: [
          {
            ...createMockUser({ mobilePhone: '+358 40 123 4567' }),
            metadata: { notes: 'x'.repeat(1000) },
            customAttributes: { badge: '42' },
          },
        ],
      });

      const { users } = await activities.fetchHubUsersPage(TEST_TENANT_ID, '0', 100);

      expect(users).toEqual([
        {
          _id: 'test-user-id-001',
          email: 'john.doe@example.com',
          status: UserStatus.ACTIVE,
          displayName: 'John Doe',
          firstName: 'John',
          lastName: 'Doe',
          sourceSystem: 'TestHR',
          sourceUserId: 'EMP-001',
          employmentType: 'FULL_TIME',
          tenantId: TEST_TENANT_ID,
        },
      ]);
    });

    it("fetches the page within the run's scan scope", async () => {
      (identityService.findUsersPageForReconciliation as jest.Mock).mockResolvedValue({
        users: [createMockUser()],
      });
      const scope = { excludedUsers: ['64b7f0c2a1b2c3d4e5f60718'] };

      await activities.fetchHubUsersPage(TEST_TENANT_ID, '200', 100, scope);

      expect(identityService.findUsersPageForReconciliation).toHaveBeenCalledWith(200, 100, scope);
    });
  });

  describe('runOrphanDetection', () => {
    const detectOrphans = jest.fn();
    const withDetectionModule = () =>
      Test.createTestingModule({
        providers: [
          ReconciliationActivities,
          { provide: IdentityService, useValue: identityService },
          { provide: EntraActivities, useValue: entraActivities },
          { provide: EntraService, useValue: entraService },
          { provide: AdService, useValue: adService },
          { provide: SCIMService, useValue: scimService },
          { provide: ConnectorConfigService, useValue: mockConnectorConfig },
          { provide: OrphanDetectionService, useValue: { detectOrphans } },
          { provide: DriftService, useValue: driftService },
          { provide: DomainEventEmitterService, useValue: eventEmitter },
          { provide: EmailNotificationService, useValue: emailNotifications },
        ],
      }).compile();

    beforeEach(() =>
      detectOrphans.mockReset().mockResolvedValue({ orphans: [], driftRecords: [] }),
    );

    // r2-05 N11: the activity had no heartbeat; the workflow now gives it a heartbeat timeout
    it('heartbeats after each page of accounts', async () => {
      detectOrphans.mockImplementation(async (_s, _t, _e, onPage: () => void) => {
        onPage();
        onPage();
        return { orphans: [], driftRecords: [] };
      });
      const withDetection = (await withDetectionModule()).get(ReconciliationActivities);
      const env = new MockActivityEnvironment();
      const beats = jest.fn();
      env.on('heartbeat', beats);

      await env.run(() => withDetection.runOrphanDetection('entra-id', TEST_TENANT_ID));

      expect(beats).toHaveBeenCalledTimes(2);
    });

    // Final review RC1: AD and SCIM are listed in one call with no page to heartbeat after, so a
    // listing longer than the 2-minute heartbeat timeout failed every attempt
    it('heartbeats on a timer while a long listing runs, and stops when it ends', async () => {
      jest.useFakeTimers();
      try {
        let finishListing!: () => void;
        detectOrphans.mockImplementation(
          () =>
            new Promise((resolve) => {
              finishListing = () => resolve({ orphans: [], driftRecords: [] });
            }),
        );
        const withDetection = (await withDetectionModule()).get(ReconciliationActivities);
        const env = new MockActivityEnvironment();
        const beats = jest.fn();
        env.on('heartbeat', beats);

        const run = env.run(() => withDetection.runOrphanDetection('ad', TEST_TENANT_ID));
        await jest.advanceTimersByTimeAsync(5 * ORPHAN_DETECTION_HEARTBEAT_MS);
        const during = beats.mock.calls.length;
        finishListing();
        await run;
        await jest.advanceTimersByTimeAsync(5 * ORPHAN_DETECTION_HEARTBEAT_MS);

        expect(during).toBeGreaterThanOrEqual(5);
        expect(beats).toHaveBeenCalledTimes(during);
        expect(ORPHAN_DETECTION_HEARTBEAT_MS).toBeLessThan(60_000);
      } finally {
        jest.useRealTimers();
      }
    });

    it("hands the run's excluded users to orphan detection", async () => {
      const module = await Test.createTestingModule({
        providers: [
          ReconciliationActivities,
          { provide: IdentityService, useValue: identityService },
          { provide: EntraActivities, useValue: entraActivities },
          { provide: EntraService, useValue: entraService },
          { provide: AdService, useValue: adService },
          { provide: SCIMService, useValue: scimService },
          { provide: ConnectorConfigService, useValue: mockConnectorConfig },
          { provide: OrphanDetectionService, useValue: { detectOrphans } },
          { provide: DriftService, useValue: driftService },
          { provide: DomainEventEmitterService, useValue: eventEmitter },
          { provide: EmailNotificationService, useValue: emailNotifications },
        ],
      }).compile();
      const withDetection = module.get(ReconciliationActivities);

      await withDetection.runOrphanDetection('entra-id', TEST_TENANT_ID, {
        includedDepartments: ['Sales'],
        excludedUsers: ['ceo@example.com'],
      });
      await withDetection.runOrphanDetection('ad', TEST_TENANT_ID);

      expect(detectOrphans).toHaveBeenNthCalledWith(
        1,
        'entra-id',
        TEST_TENANT_ID,
        ['ceo@example.com'],
        expect.any(Function),
      );
      expect(detectOrphans).toHaveBeenNthCalledWith(
        2,
        'ad',
        TEST_TENANT_ID,
        undefined,
        expect.any(Function),
      );
    });
  });

  describe('detectUserDrift', () => {
    it('should return MISSING_USER drift when user not in system', async () => {
      const user = createMockUser();
      (entraService.getUserByEmail as jest.Mock).mockResolvedValue(null);

      const result = await activities.detectUserDrift(user, ['entra-id'], TEST_TENANT_ID);

      expect(result.hasDrift).toBe(true);
      expect(result.drifts).toHaveLength(1);
      expect(result.drifts[0].driftType).toBe(DriftType.MISSING_USER);
      expect(result.drifts[0].system).toBe('entra-id');
    });

    /**
     * The account lookups (Entra ID, AD, SCIM getUserByEmail) return the account's id, UPN, mail,
     * display name and enabled state only. Compared against fields no lookup returns (firstName,
     * jobTitle, mobilePhone and the like), every hub value counted as "the target has none": a
     * FIELD_MISMATCH per field on every run, auto-corrected by re-provisioning (hunt 05 F1).
     */
    describe('compares what the target account carries', () => {
      const entraAccount = (overrides: Record<string, unknown> = {}) => ({
        id: 'entra-1',
        userPrincipalName: 'john.doe@example.com',
        mail: 'john.doe@example.com',
        displayName: 'John Doe',
        accountEnabled: true,
        ...overrides,
      });

      it('an account that matches the hub record gives no drift', async () => {
        const user = createMockUser({ mobilePhone: '+358 40 123 4567', officeLocation: 'HQ' });
        (entraService.getUserByEmail as jest.Mock).mockResolvedValue(entraAccount());

        const result = await activities.detectUserDrift(user, ['entra-id'], TEST_TENANT_ID);

        expect(result.drifts).toEqual([]);
        expect(result.hasDrift).toBe(false);
        expect(eventEmitter.emit).not.toHaveBeenCalled();
      });

      it('a display name that differs is a FIELD_MISMATCH the correction can fix', async () => {
        const user = createMockUser({ displayName: 'Jane Smith-Doe' });
        (entraService.getUserByEmail as jest.Mock).mockResolvedValue(entraAccount());

        const result = await activities.detectUserDrift(user, ['entra-id'], TEST_TENANT_ID);

        expect(result.drifts).toEqual([
          expect.objectContaining({
            driftType: DriftType.FIELD_MISMATCH,
            field: 'displayName',
            expectedValue: 'Jane Smith-Doe',
            actualValue: 'John Doe',
            autoCorrect: true,
          }),
        ]);
      });

      it('a display name differing only in case or spaces is no drift', async () => {
        const user = createMockUser({ displayName: ' john doe ' });
        (entraService.getUserByEmail as jest.Mock).mockResolvedValue(entraAccount());

        const result = await activities.detectUserDrift(user, ['entra-id'], TEST_TENANT_ID);

        expect(result.drifts).toEqual([]);
      });

      it('a hub record without a display name compares none (provisioning writes none then)', async () => {
        const user = createMockUser({ displayName: undefined });
        (entraService.getUserByEmail as jest.Mock).mockResolvedValue(
          entraAccount({ displayName: 'Johnny' }),
        );

        const result = await activities.detectUserDrift(user, ['entra-id'], TEST_TENANT_ID);

        expect(result.drifts).toEqual([]);
      });

      it('an AD account, whose lookup carries no display name, raises no field drift', async () => {
        const user = createMockUser();
        mockConnectorConfig.getConfig.mockResolvedValue({
          config: { host: 'dc.corp.example', rootBaseDn: 'DC=corp,DC=example' },
        });
        adService.getUserByEmail.mockResolvedValue({
          id: 'CN=John Doe,DC=corp,DC=example',
          userPrincipalName: user.email,
          mail: user.email,
          displayName: undefined,
          accountEnabled: true,
        });

        const result = await activities.detectUserDrift(user, ['ad'], TEST_TENANT_ID);

        expect(result.drifts).toEqual([]);
      });

      it('a SCIM display name drift is reported, not auto-corrected (no field correction there)', async () => {
        const user = createMockUser({ displayName: 'Jane Smith-Doe' });
        mockConnectorConfig.getConfig.mockResolvedValue({
          config: { baseUrl: 'https://scim.example.com', authType: 'bearer', token: 't' },
        });
        scimService.getUserByEmail.mockResolvedValue(entraAccount({ id: 'scim-1' }));

        const result = await activities.detectUserDrift(user, ['scim'], TEST_TENANT_ID);

        expect(result.drifts).toEqual([
          expect.objectContaining({ field: 'displayName', autoCorrect: false }),
        ]);
      });
    });

    /**
     * The hub status was compared with the literals ACTIVE and DISABLED, so every leaver,
     * suspended or pending identity raised a CRITICAL STATUS_MISMATCH that never cleared
     * (hunt r2-05 N1). The expected state is the one provisioning writes (targetAccountEnabled).
     */
    describe('status: the enabled state provisioning writes for the hub status', () => {
      const account = (accountEnabled: boolean) => ({
        id: 'entra-1',
        mail: 'john.doe@example.com',
        displayName: 'John Doe',
        accountEnabled,
      });

      it.each([
        [UserStatus.TERMINATED, false],
        [UserStatus.SUSPENDED, false],
        [UserStatus.INACTIVE, false],
        [UserStatus.DELETED, false],
        [UserStatus.ACTIVE, true],
        [UserStatus.PENDING, true],
      ])('%s with an account enabled=%s is no drift', async (status, enabled) => {
        (entraService.getUserByEmail as jest.Mock).mockResolvedValue(account(enabled));

        const result = await activities.detectUserDrift(
          createMockUser({ status }),
          ['entra-id'],
          TEST_TENANT_ID,
        );

        expect(result.drifts).toEqual([]);
      });

      it('a leaver whose account is still enabled: a CRITICAL drift the run may disable', async () => {
        (entraService.getUserByEmail as jest.Mock).mockResolvedValue(account(true));

        const result = await activities.detectUserDrift(
          createMockUser({ status: UserStatus.TERMINATED }),
          ['entra-id'],
          TEST_TENANT_ID,
        );

        expect(result.drifts).toEqual([
          expect.objectContaining({
            driftType: DriftType.STATUS_MISMATCH,
            field: 'status',
            expectedValue: 'DISABLED',
            actualValue: 'ENABLED',
            severity: 'CRITICAL',
            autoCorrect: true,
          }),
        ]);
        expect(result.drifts[0].description).toContain('TERMINATED');
      });

      it('an active identity whose account is disabled: CRITICAL, enabling stays manual', async () => {
        (entraService.getUserByEmail as jest.Mock).mockResolvedValue(account(false));

        const result = await activities.detectUserDrift(
          createMockUser({ status: UserStatus.ACTIVE }),
          ['entra-id'],
          TEST_TENANT_ID,
        );

        expect(result.drifts).toEqual([
          expect.objectContaining({
            driftType: DriftType.STATUS_MISMATCH,
            expectedValue: 'ENABLED',
            actualValue: 'DISABLED',
            severity: 'CRITICAL',
            autoCorrect: false,
          }),
        ]);
      });

      it('a linked admin account outside its session is expected disabled', async () => {
        (entraService.getUserByEmail as jest.Mock).mockResolvedValue(account(true));

        const result = await activities.detectUserDrift(
          createMockUser({
            status: UserStatus.INACTIVE,
            employmentType: 'ADMIN_ACCOUNT' as never,
            sourceSystem: 'euroid-pam',
          }),
          ['entra-id'],
          TEST_TENANT_ID,
        );

        expect(result.drifts).toEqual([
          expect.objectContaining({ expectedValue: 'DISABLED', autoCorrect: true }),
        ]);
      });
    });

    it('fails (retried) instead of reporting the user missing when the config cannot be decrypted', async () => {
      (entraService.getUserByEmail as jest.Mock).mockRejectedValue(
        new ConnectorConfigDecryptError('entra-id'),
      );

      await expect(
        activities.detectUserDrift(createMockUser(), ['entra-id'], TEST_TENANT_ID),
      ).rejects.toBeInstanceOf(ConnectorConfigDecryptError);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('names the identity by its id, never its email, in a missing-user drift', async () => {
      const user = createMockUser();

      const result = await activities.detectUserDrift(user, ['entra-id'], TEST_TENANT_ID);

      expect(result.drifts[0].description).toBe(
        'Identity test-user-id-001 exists in Hub but not in entra-id',
      );
      expect(JSON.stringify(result.drifts)).not.toContain(user.email);
    });

    // Read as "no account", a target that cannot be read raised MISSING_USER for every user,
    // auto-corrected for the active ones. It is an error for that system's reconciliation now.
    describe('a target system whose accounts cannot be read', () => {
      const entraAccount = (user: ReturnType<typeof createMockUser>) => ({
        id: 'entra-1',
        mail: user.email,
        accountEnabled: true,
      });

      it.each([
        [
          'ad',
          { rootBaseDn: 'DC=corp,DC=example' },
          'AD connector config is incomplete (empty: host)',
        ],
        [
          'ad',
          { host: 'dc.corp.example', serviceAccount: 'CN=svc', password: 'pw' },
          'AD connector config is incomplete (empty: rootBaseDn)',
        ],
        ['ad', {}, 'AD connector config is incomplete (empty: host, rootBaseDn)'],
        ['scim', { authType: 'bearer' }, 'SCIM connector config is incomplete (empty: baseUrl)'],
      ])(
        'an installed %s config %j: an error naming the setting, no drift for it',
        async (system, config, message) => {
          const user = createMockUser();
          mockConnectorConfig.getConfig.mockResolvedValue({ config });
          (entraService.getUserByEmail as jest.Mock).mockResolvedValue(entraAccount(user));

          const result = await activities.detectUserDrift(
            user,
            ['entra-id', system],
            TEST_TENANT_ID,
          );

          expect(result.drifts.filter((d) => d.system === system)).toEqual([]);
          expect(result.systemErrors).toEqual([
            { system, error: expect.stringContaining(message) },
          ]);
          expect(adService.getUserByEmail).not.toHaveBeenCalled();
          expect(scimService.getUserByEmail).not.toHaveBeenCalled();
          // Its open drifts are neither added to nor closed: only Entra ID was read
          expect(driftService.recordDetection).toHaveBeenCalledWith(
            expect.objectContaining({ checkedSystems: ['entra-id'] }),
            expect.not.arrayContaining([expect.objectContaining({ targetSystem: system })]),
          );
        },
      );

      it('a target without an installed connector config is an error, not a missing user', async () => {
        const result = await activities.detectUserDrift(createMockUser(), ['ad'], TEST_TENANT_ID);

        expect(result.drifts).toEqual([]);
        expect(result.hasDrift).toBe(false);
        expect(result.systemErrors).toEqual([
          { system: 'ad', error: expect.stringContaining('No ad connector config is installed') },
        ]);
      });

      it('a connector call that fails is an error, not a missing user', async () => {
        (entraService.getUserByEmail as jest.Mock).mockRejectedValue(
          new Error('Graph answered 503 for john.doe@example.com'),
        );

        const result = await activities.detectUserDrift(
          createMockUser(),
          ['entra-id'],
          TEST_TENANT_ID,
        );

        expect(result.drifts).toEqual([]);
        expect(result.systemErrors).toEqual([
          { system: 'entra-id', error: 'Graph answered 503 for j•••@example.com' },
        ]);
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        expect(driftService.recordDetection).toHaveBeenCalledWith(
          expect.objectContaining({ checkedSystems: [] }),
          [],
        );
      });
    });

    it("reports the identity's key fields as hubState, never its whole profile", async () => {
      const user = createMockUser({ mobilePhone: '+358 40 123 4567' });

      const result = await activities.detectUserDrift(user, ['entra-id'], TEST_TENANT_ID);

      expect(result.hubState).toEqual(
        expect.objectContaining({ _id: 'test-user-id-001', email: user.email, status: 'ACTIVE' }),
      );
      expect(result.hubState).not.toHaveProperty('mobilePhone');
      expect(result.hubState).not.toHaveProperty('jobTitle');
    });

    it('stores what it detects under the identity id, for the systems it read', async () => {
      const user = createMockUser();

      await activities.detectUserDrift(user, ['entra-id'], TEST_TENANT_ID);

      expect(driftService.recordDetection).toHaveBeenCalledWith(
        {
          identityId: 'test-user-id-001',
          displayName: 'John Doe',
          email: 'john.doe@example.com',
          checkedSystems: ['entra-id'],
        },
        [
          {
            targetSystem: 'entra-id',
            type: 'MISSING_USER',
            severity: 'high',
            autoCorrectEligible: true,
          },
        ],
      );
    });

    it('stores field and status drifts with the values it detected', async () => {
      const user = createMockUser({ displayName: 'Jane Smith-Doe', status: UserStatus.SUSPENDED });
      (entraService.getUserByEmail as jest.Mock).mockResolvedValue({
        id: 'entra-1',
        mail: user.email,
        displayName: 'John Doe',
        accountEnabled: true,
      });

      await activities.detectUserDrift(user, ['entra-id'], TEST_TENANT_ID);

      expect(driftService.recordDetection.mock.calls[0][1]).toEqual([
        {
          targetSystem: 'entra-id',
          type: 'FIELD_MISMATCH',
          field: 'displayName',
          severity: 'medium',
          hubValue: 'Jane Smith-Doe',
          targetValue: 'John Doe',
          autoCorrectEligible: true,
        },
        {
          targetSystem: 'entra-id',
          type: 'STATUS_MISMATCH',
          field: 'status',
          severity: 'critical',
          hubValue: 'DISABLED',
          targetValue: 'ENABLED',
          autoCorrectEligible: true,
        },
      ]);
    });
  });

  describe('correctDrift', () => {
    it('should call provisionUserToEntra for MISSING_USER drift in entra-id', async () => {
      const user = createMockUser();
      const drift = {
        system: 'entra-id',
        driftType: DriftType.MISSING_USER,
        description: 'User missing',
        severity: 'HIGH' as const,
        autoCorrect: true,
      };

      const result = await activities.correctDrift(drift, user, TEST_TENANT_ID);

      expect(result.success).toBe(true);
      expect(entraActivities.provisionUserToEntra).toHaveBeenCalled();
    });

    const missingInEntra = {
      system: 'entra-id',
      driftType: DriftType.MISSING_USER,
      description: 'Identity test-user-id-001 exists in Hub but not in entra-id',
      severity: 'HIGH' as const,
      autoCorrect: true,
    };

    it('provisions from the stored identity, not from the key fields the batch carries', async () => {
      const stored = createMockUser({ jobTitle: 'Architect' });
      identityService.findUserForReconciliation = jest.fn().mockResolvedValue(stored);
      const carried = { _id: 'test-user-id-001', email: stored.email, status: 'ACTIVE' };

      const result = await activities.correctDrift(
        missingInEntra,
        carried as never,
        TEST_TENANT_ID,
      );

      expect(identityService.findUserForReconciliation).toHaveBeenCalledWith('test-user-id-001');
      expect(entraActivities.provisionUserToEntra).toHaveBeenCalledWith(
        stored,
        undefined,
        undefined,
        TEST_TENANT_ID,
      );
      expect(result.success).toBe(true);
      expect(result.user).toEqual(carried);
    });

    it('corrects nothing for an identity no longer in the hub', async () => {
      identityService.findUserForReconciliation = jest.fn().mockResolvedValue(null);

      const result = await activities.correctDrift(
        missingInEntra,
        createMockUser(),
        TEST_TENANT_ID,
      );

      expect(result).toMatchObject({
        success: false,
        error: 'Identity test-user-id-001 is no longer in the hub',
      });
      expect(entraActivities.provisionUserToEntra).not.toHaveBeenCalled();
    });

    it('ids the correction by the identity id, never the email, and closes the drift it fixed', async () => {
      const user = createMockUser();

      const result = await activities.correctDrift(missingInEntra, user, TEST_TENANT_ID);

      expect(result.driftId).toBe('entra-id:test-user-id-001:MISSING_USER');
      expect(driftService.closeCorrectedDrift).toHaveBeenCalledWith(
        'test-user-id-001',
        'entra-id',
        'MISSING_USER',
        undefined,
      );
    });

    describe('STATUS_MISMATCH: the account gets the state the hub status expects', () => {
      const statusDrift = (system: string, expectedValue: 'ENABLED' | 'DISABLED') => ({
        system,
        driftType: DriftType.STATUS_MISMATCH,
        field: 'status',
        expectedValue,
        actualValue: expectedValue === 'ENABLED' ? 'DISABLED' : 'ENABLED',
        description: 'status',
        severity: 'CRITICAL' as const,
        autoCorrect: expectedValue === 'DISABLED',
      });

      it('disables the Entra ID account of a leaver', async () => {
        const user = createMockUser({ status: UserStatus.TERMINATED });
        identityService.findUserForReconciliation = jest.fn().mockResolvedValue(user);

        const result = await activities.correctDrift(
          statusDrift('entra-id', 'DISABLED'),
          user,
          TEST_TENANT_ID,
        );

        expect(result).toMatchObject({ success: true, action: 'DISABLE' });
        expect(entraActivities.disableEntraUser).toHaveBeenCalledWith(user.email, TEST_TENANT_ID);
      });

      it('enables a PENDING identity, as provisioning creates its account', async () => {
        const user = createMockUser({ status: UserStatus.PENDING });
        identityService.findUserForReconciliation = jest.fn().mockResolvedValue(user);

        const result = await activities.correctDrift(
          statusDrift('entra-id', 'ENABLED'),
          user,
          TEST_TENANT_ID,
        );

        expect(result).toMatchObject({ success: true, action: 'ENABLE' });
        expect(entraActivities.enableEntraUser).toHaveBeenCalledWith(user.email, TEST_TENANT_ID);
        expect(entraActivities.disableEntraUser).not.toHaveBeenCalled();
      });

      it('disables the AD account, found by the email, by its DN', async () => {
        const user = createMockUser({ status: UserStatus.TERMINATED });
        identityService.findUserForReconciliation = jest.fn().mockResolvedValue(user);
        const adConfig = { host: 'dc.corp.example', rootBaseDn: 'DC=corp,DC=example' };
        mockConnectorConfig.getConfig.mockResolvedValue({ config: adConfig });
        adService.getUserByEmail.mockResolvedValue({ id: 'CN=John Doe,DC=corp,DC=example' });
        adService.setUserEnabled.mockResolvedValue({ outcome: 'done', detail: 'disabled' });

        const result = await activities.correctDrift(
          statusDrift('ad', 'DISABLED'),
          user,
          TEST_TENANT_ID,
        );

        expect(result.success).toBe(true);
        expect(adService.setUserEnabled).toHaveBeenCalledWith(
          expect.objectContaining({ host: 'dc.corp.example' }),
          'CN=John Doe,DC=corp,DC=example',
          false,
        );
      });

      it('deactivates the SCIM user, looked up by the email', async () => {
        const user = createMockUser({ status: UserStatus.TERMINATED });
        identityService.findUserForReconciliation = jest.fn().mockResolvedValue(user);
        mockConnectorConfig.getConfig.mockResolvedValue({
          config: { baseUrl: 'https://scim.example.com', authType: 'bearer', token: 't' },
        });
        scimService.setActive.mockResolvedValue({ outcome: 'done', detail: 'deactivated' });

        const result = await activities.correctDrift(
          statusDrift('scim', 'DISABLED'),
          user,
          TEST_TENANT_ID,
        );

        expect(result.success).toBe(true);
        expect(scimService.setActive).toHaveBeenCalledWith(
          expect.objectContaining({ baseUrl: 'https://scim.example.com' }),
          { userNames: [user.email], emails: [user.email] },
          false,
        );
      });

      it('an account the target no longer has is not reported corrected', async () => {
        mockConnectorConfig.getConfig.mockResolvedValue({
          config: { baseUrl: 'https://scim.example.com', authType: 'bearer', token: 't' },
        });
        scimService.setActive.mockResolvedValue({ outcome: 'not-found', detail: 'no such user' });

        const result = await activities.correctDrift(
          statusDrift('scim', 'DISABLED'),
          createMockUser({ status: UserStatus.TERMINATED }),
          TEST_TENANT_ID,
        );

        expect(result.success).toBe(false);
        expect(driftService.closeCorrectedDrift).not.toHaveBeenCalled();
      });
    });

    it('leaves the stored drift open when the correction fails', async () => {
      (entraActivities.provisionUserToEntra as jest.Mock).mockRejectedValue(new Error('Graph 503'));

      const result = await activities.correctDrift(
        missingInEntra,
        createMockUser(),
        TEST_TENANT_ID,
      );

      expect(result.success).toBe(false);
      expect(driftService.closeCorrectedDrift).not.toHaveBeenCalled();
    });
  });

  /**
   * A run reached a drift threshold with notifyOnDrift on (dailyReconciliationWorkflow, patch
   * reconciliation:drift-threshold-alerts): one event with counts and the run's ids, never an
   * address or identity data, and a mail to notifyEmail when the run named one.
   */
  describe('notifyDriftThresholdExceeded', () => {
    const counts = {
      workflowId: 't-tenant-a-daily-recon',
      runId: 'run-1',
      totalDrifts: 12,
      criticalDrifts: 5,
      alerts: [
        { threshold: 'maxDriftsBeforeAlert' as const, limit: 10, found: 12 },
        { threshold: 'criticalDriftAlertThreshold' as const, limit: 5, found: 5 },
      ],
    };

    it('emits reconciliation.drift_threshold_exceeded once with the counts', async () => {
      await activities.notifyDriftThresholdExceeded(TEST_TENANT_ID, {
        ...counts,
        notifyEmail: 'secops@example.com',
      });

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.RECONCILIATION_DRIFT_THRESHOLD_EXCEEDED,
        'run-1',
        counts,
      );
      expect(JSON.stringify(eventEmitter.emit.mock.calls)).not.toContain('secops@example.com');
    });

    it('mails notifyEmail, a user of the tenant, with the counts', async () => {
      await activities.notifyDriftThresholdExceeded(TEST_TENANT_ID, {
        ...counts,
        notifyEmail: 'secops@example.com',
      });

      expect(emailNotifications.notifyDriftThreshold).toHaveBeenCalledWith(TEST_TENANT_ID, {
        runId: 'run-1',
        recipientKey: 'secops@example.com',
        totalDrifts: 12,
        criticalDrifts: 5,
        alerts: counts.alerts,
      });
    });

    it('mails nobody when the run named no address', async () => {
      await activities.notifyDriftThresholdExceeded(TEST_TENANT_ID, counts);

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(emailNotifications.notifyDriftThreshold).not.toHaveBeenCalled();
    });

    it('does not fail (and emit again on a retry) when the mail cannot be sent', async () => {
      emailNotifications.notifyDriftThreshold.mockRejectedValue(new Error('MongoDB unavailable'));

      await expect(
        activities.notifyDriftThresholdExceeded(TEST_TENANT_ID, {
          ...counts,
          notifyEmail: 'secops@example.com',
        }),
      ).resolves.toBeUndefined();
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateReport', () => {
    it('should return report with deterministic reportId format', async () => {
      const startTime = new Date('2024-01-15T10:00:00Z');
      const user = createMockUser();
      const drifts = [
        {
          userId: 'u1',
          email: 'u@ex.com',
          hasDrift: true,
          hubState: user,
          systemStates: new Map(),
          drifts: [
            {
              system: 'entra-id',
              driftType: DriftType.MISSING_USER,
              description: 'Missing',
              severity: 'HIGH' as const,
              autoCorrect: true,
            },
          ],
          severity: 'HIGH' as const,
          detectedAt: new Date(),
        },
      ];
      const corrections = [
        {
          driftId: 'd1',
          system: 'entra-id',
          action: 'CREATE' as const,
          user,
          success: true,
          executedAt: new Date(),
        },
      ];

      const result = await activities.generateReport(
        TEST_TENANT_ID,
        drifts,
        corrections,
        startTime,
      );

      expect(result.reportId).toMatch(new RegExp(`^recon-${TEST_TENANT_ID}-\\d+$`));
      expect(result.totalUsers).toBe(1);
      expect(result.usersWithDrift).toBe(1);
      expect(result.startedAt).toEqual(startTime);
    });

    // The severity fields count drifts, as totalDrifts and the run's threshold alert do: one
    // identity with two CRITICAL drifts is 2, not one identity whose worst drift is CRITICAL.
    it('counts drifts per severity, so the figures add up to totalDrifts and match the alert', async () => {
      const user = createMockUser();
      const drift = (driftType: DriftType, severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW') => ({
        system: 'entra-id',
        driftType,
        description: driftType,
        severity,
        autoCorrect: false,
      });
      const drifts = [
        {
          userId: 'u1',
          email: 'u@ex.com',
          hasDrift: true,
          hubState: user,
          systemStates: new Map(),
          drifts: [
            drift(DriftType.STATUS_MISMATCH, 'CRITICAL'),
            drift(DriftType.STATUS_MISMATCH, 'CRITICAL'),
            drift(DriftType.FIELD_MISMATCH, 'MEDIUM'),
          ],
          severity: 'CRITICAL' as const,
          detectedAt: new Date(),
        },
        {
          userId: 'u2',
          email: 'v@ex.com',
          hasDrift: true,
          hubState: user,
          systemStates: new Map(),
          drifts: [drift(DriftType.FIELD_MISMATCH, 'LOW'), drift(DriftType.MISSING_USER, 'HIGH')],
          severity: 'HIGH' as const,
          detectedAt: new Date(),
        },
      ];

      const report = await activities.generateReport(TEST_TENANT_ID, drifts, [], new Date());
      const alert = driftThresholdAlerts(
        { maxDriftsBeforeAlert: 0, criticalDriftAlertThreshold: 2 },
        drifts,
      );

      expect(report).toMatchObject({
        totalDrifts: 5,
        criticalDrifts: 2,
        highDrifts: 1,
        mediumDrifts: 1,
        lowDrifts: 1,
      });
      expect(
        report.criticalDrifts + report.highDrifts + report.mediumDrifts + report.lowDrifts,
      ).toBe(report.totalDrifts);
      expect(alert.alerts).toEqual([
        { threshold: 'criticalDriftAlertThreshold', limit: 2, found: report.criticalDrifts },
      ]);
    });
  });

  describe('tenant context rejection', () => {
    it('should throw when tenantId is empty', async () => {
      await expect(activities.getReconciliationUserCount('')).rejects.toThrow('[SECURITY]');
    });

    it('should throw when fetchHubUsersPage called with empty tenantId', async () => {
      await expect(activities.fetchHubUsersPage('', '0', 100)).rejects.toThrow('[SECURITY]');
    });

    it('should throw when fetchHubUsersPage called with whitespace tenantId', async () => {
      await expect(activities.fetchHubUsersPage('   ', '0', 100)).rejects.toThrow('[SECURITY]');
    });
  });
});
