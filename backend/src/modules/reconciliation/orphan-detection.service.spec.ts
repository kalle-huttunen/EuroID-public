/**
 * OrphanDetectionService unit tests
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { OrphanDetectionService } from './orphan-detection.service';
import { IdentityService } from '../identity/identity.service';
import { DriftService } from './drift.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { AdService } from '../connectors/ad-connector/ad.service';
import { SCIMService } from '../connectors/scim-connector/scim.service';
import { ConnectorConfigService } from '../connectors/connector-config.service';
import { orphanConfig } from '@infrastructure/config/orphan.config';
import { OrphanCleanupService } from './orphan-cleanup.service';

describe('OrphanDetectionService', () => {
  let service: OrphanDetectionService;
  let identityService: jest.Mocked<Partial<IdentityService>>;
  let driftService: jest.Mocked<Partial<DriftService>>;
  let eventEmitter: jest.Mocked<Partial<DomainEventEmitterService>>;
  let entraService: jest.Mocked<Partial<EntraService>>;
  const adService = { listUsers: jest.fn() };
  const connectorConfig = { getConfig: jest.fn() };
  /** ORPHAN_EXCLUDED_ACCOUNTS as the config reads it: emptied before each test. */
  const excluded: string[] = [];

  beforeEach(async () => {
    excluded.length = 0;
    adService.listUsers.mockReset().mockResolvedValue([]);
    connectorConfig.getConfig.mockReset().mockResolvedValue(null);
    const findUserForReconciliation = jest.fn();
    identityService = {
      findUserForReconciliation,
      // The page's one query over the same hub: the keys whose identity is live and not
      // TERMINATED or DELETED (IdentityQueryService.findLiveOwnerKeys, integration-tested)
      findLiveOwnerKeys: jest.fn(async (keys: string[]) => {
        const owned = new Set<string>();
        for (const key of keys) {
          const owner = (await findUserForReconciliation(key)) as { status?: string } | null;
          if (owner?.status && !['TERMINATED', 'DELETED'].includes(owner.status)) owned.add(key);
        }
        return owned;
      }),
    };
    driftService = {
      // No orphan drift recorded for the account yet
      findOrphanDrifts: jest.fn().mockResolvedValue([]),
      saveDrift: jest.fn().mockResolvedValue({
        _id: 'drift-123',
        type: 'ORPHAN_ACCOUNT',
        status: 'quarantined',
        tenantId: 'test',
        targetSystem: 'entra-id',
        userId: 'ext-1',
        userDisplayName: 'Test User',
        userEmail: 'test@example.com',
        orphanDetails: { externalId: 'ext-1', targetSystem: 'entra-id' },
      }),
    };
    eventEmitter = { emit: jest.fn() };
    entraService = {
      listUsers: jest.fn().mockResolvedValue({
        users: [
          {
            id: 'ext-1',
            userPrincipalName: 'orphan@example.com',
            mail: 'orphan@example.com',
            displayName: 'Orphan User',
            accountEnabled: true,
          },
        ],
        nextLink: undefined,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrphanDetectionService,
        { provide: IdentityService, useValue: identityService },
        { provide: DriftService, useValue: driftService },
        { provide: DomainEventEmitterService, useValue: eventEmitter },
        { provide: EntraService, useValue: entraService },
        { provide: AdService, useValue: adService },
        { provide: SCIMService, useValue: { listUsers: jest.fn().mockResolvedValue([]) } },
        { provide: ConnectorConfigService, useValue: connectorConfig },
        {
          provide: orphanConfig.KEY,
          useValue: { gracePeriodDays: 30, excludedAccounts: excluded },
        },
        // Read only for an account with a closed orphan drift (orphan-detection-records spec)
        { provide: OrphanCleanupService, useValue: { isRunning: jest.fn() } },
      ],
    }).compile();

    service = module.get(OrphanDetectionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  /**
   * One 5-minute activity without a heartbeat listed every account and made up to six hub
   * lookups per account (r2-05 N11). Detection now works page by page: one hub query for the
   * page's keys, and a progress call after each page (the activity heartbeats it).
   */
  describe('page by page', () => {
    const acct = (id: string) => ({ id, userPrincipalName: `${id}@example.com` });

    it('asks the hub once per page and reports each page done', async () => {
      (entraService.listUsers as jest.Mock)
        .mockResolvedValueOnce({ users: [acct('a'), acct('b')], nextLink: 'https://graph/next' })
        .mockResolvedValueOnce({ users: [acct('c')], nextLink: undefined });
      (identityService.findUserForReconciliation as jest.Mock).mockImplementation(
        async (key: string) => (key === 'b@example.com' ? { _id: 'id-b', status: 'ACTIVE' } : null),
      );
      const onPage = jest.fn();

      const result = await service.detectOrphans('entra-id', 'test-tenant', undefined, onPage);

      expect(result.orphans.map((o) => o.externalId)).toEqual(['a', 'c']);
      expect(identityService.findLiveOwnerKeys).toHaveBeenCalledTimes(2);
      expect(identityService.findLiveOwnerKeys).toHaveBeenNthCalledWith(
        1,
        expect.arrayContaining(['a@example.com', 'a', 'b@example.com', 'b']),
      );
      expect(onPage).toHaveBeenCalledTimes(2);
      expect(entraService.listUsers).toHaveBeenNthCalledWith(2, { nextLink: 'https://graph/next' });
    });

    it('splits a system listed at once into pages of 500', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: { host: 'ldap.corp.example', rootBaseDn: 'DC=corp,DC=example' },
      });
      adService.listUsers.mockResolvedValue(
        Array.from({ length: 1001 }, (_, i) => ({ id: `CN=u${i}`, objectGuid: `g-${i}` })),
      );
      (identityService.findUserForReconciliation as jest.Mock).mockResolvedValue({
        _id: 'id-1',
        status: 'ACTIVE',
      });
      const onPage = jest.fn();

      await service.detectOrphans('ad', 'test-tenant', undefined, onPage);

      expect(identityService.findLiveOwnerKeys).toHaveBeenCalledTimes(3);
      expect(onPage).toHaveBeenCalledTimes(3);
    });
  });

  it('should detect orphans when no Hub identity exists', async () => {
    (identityService.findUserForReconciliation as jest.Mock).mockResolvedValue(null);

    const result = await service.detectOrphans('entra-id', 'test-tenant');

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0].externalId).toBe('ext-1');
    expect(result.orphans[0].accountIdentifier).toBe('orphan@example.com');
    expect(result.driftRecords).toHaveLength(1);
    expect(driftService.saveDrift).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ORPHAN_ACCOUNT',
        status: 'quarantined',
        targetSystem: 'entra-id',
        userId: 'ext-1',
      }),
    );
    expect(eventEmitter.emit).toHaveBeenCalled();
  });

  /**
   * An account was matched to an identity only by `profile.email` equal to its UPN (its mail
   * only when the UPN was empty), case-sensitively, so an active employee whose UPN differs from
   * the stored email in case or altogether was quarantined and later disabled (hunt 05 F10).
   * Guests, break-glass and service accounts, which have no HR identity, were too (r2-05 N5).
   */
  describe('which accounts count as orphans', () => {
    const account = (overrides: Record<string, unknown>) => ({
      id: 'ext-1',
      userPrincipalName: 'orphan@example.com',
      mail: 'orphan@example.com',
      displayName: 'Orphan User',
      accountEnabled: true,
      ...overrides,
    });
    const withAccounts = (...users: Array<Record<string, unknown>>) =>
      (entraService.listUsers as jest.Mock).mockResolvedValue({ users, nextLink: undefined });
    /** The hub holds an ACTIVE identity whose stored (lower-cased) email is `email`. */
    const hubHas = (email: string) =>
      (identityService.findUserForReconciliation as jest.Mock).mockImplementation(
        async (key: string) => (key === email ? { _id: 'id-1', email, status: 'ACTIVE' } : null),
      );

    it('matches the UPN to the stored email whatever its case', async () => {
      withAccounts(account({ userPrincipalName: 'Jane.Doe@Example.com', mail: undefined }));
      hubHas('jane.doe@example.com');

      const result = await service.detectOrphans('entra-id', 'test-tenant');

      expect(result.orphans).toEqual([]);
    });

    it("matches the mail when the UPN is not the identity's email", async () => {
      withAccounts(
        account({ userPrincipalName: 'jdoe@corp.onmicrosoft.com', mail: 'Jane.Doe@x.fi' }),
      );
      hubHas('jane.doe@x.fi');

      const result = await service.detectOrphans('entra-id', 'test-tenant');

      expect(result.orphans).toEqual([]);
    });

    it('leaves guest accounts (#EXT# in the UPN) alone', async () => {
      withAccounts(account({ userPrincipalName: 'partner_ext.com#EXT#@corp.onmicrosoft.com' }));
      hubHas('nobody@example.com');

      const result = await service.detectOrphans('entra-id', 'test-tenant');

      expect(result.orphans).toEqual([]);
      expect(driftService.saveDrift).not.toHaveBeenCalled();
    });

    it('leaves the accounts of ORPHAN_EXCLUDED_ACCOUNTS alone, a * matching any text', async () => {
      excluded.push('BreakGlass@corp.example', 'svc-*@corp.example');
      withAccounts(
        account({ id: 'a', userPrincipalName: 'breakglass@corp.example', mail: undefined }),
        account({ id: 'b', userPrincipalName: 'svc-backup@corp.example', mail: undefined }),
        account({ id: 'c', userPrincipalName: 'svcbackup@corp.example', mail: undefined }),
      );
      hubHas('nobody@example.com');

      const result = await service.detectOrphans('entra-id', 'test-tenant');

      expect(result.orphans.map((o) => o.externalId)).toEqual(['c']);
    });

    it('still quarantines an account no identity has', async () => {
      withAccounts(account({ userPrincipalName: 'gone@example.com', mail: 'gone@example.com' }));
      hubHas('someone.else@example.com');

      const result = await service.detectOrphans('entra-id', 'test-tenant');

      expect(result.orphans).toHaveLength(1);
    });
  });

  // orphan.detected reaches the audit log, the tenant websocket and webhooks
  describe('the orphan.detected event', () => {
    const emitted = () => {
      const calls = (eventEmitter.emit as jest.Mock).mock.calls;
      expect(calls).toHaveLength(1);
      const [type, aggregateId, payload] = calls[0] as [string, string, Record<string, unknown>];
      expect(type).toBe('orphan.detected');
      return { aggregateId, payload };
    };

    beforeEach(() => {
      (identityService.findUserForReconciliation as jest.Mock).mockResolvedValue(null);
    });

    it('names an Entra ID account by its object id, without its UPN or mail', async () => {
      await service.detectOrphans('entra-id', 'test-tenant');

      const { aggregateId, payload } = emitted();
      expect(aggregateId).toBe('ext-1');
      expect(payload).toEqual({
        driftId: 'drift-123',
        targetSystem: 'entra-id',
        externalId: 'ext-1',
        accountIdentifier: 'ext-1',
        tenantId: 'test-tenant',
      });
      expect(JSON.stringify(payload)).not.toContain('orphan@example.com');
    });

    it('names an AD account, whose id is its DN, by its masked UPN', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: { host: 'ldap.corp.example', rootBaseDn: 'DC=corp,DC=example' },
      });
      adService.listUsers.mockResolvedValue([
        {
          id: 'CN=Ada Lovelace,OU=Users,DC=corp,DC=example',
          userPrincipalName: 'ada.lovelace@corp.example',
          displayName: 'Ada Lovelace',
        },
      ]);

      await service.detectOrphans('ad', 'test-tenant');

      const { payload } = emitted();
      expect(payload.accountIdentifier).toBe('a•••@corp.example');
      expect(JSON.stringify(payload)).not.toContain('ada.lovelace@corp.example');
    });

    // The DN's CN is the person's name, and the aggregate becomes the audit entry's resourceId
    // and the webhook's aggregateId: an AD orphan goes under its objectGUID.
    it('names an AD account by its objectGUID: aggregate, externalId and drift', async () => {
      const guid = '33221100-5544-7766-8899-aabbccddeeff';
      connectorConfig.getConfig.mockResolvedValue({
        config: { host: 'ldap.corp.example', rootBaseDn: 'DC=corp,DC=example' },
      });
      adService.listUsers.mockResolvedValue([
        {
          id: 'CN=Ada Lovelace,OU=Users,DC=corp,DC=example',
          objectGuid: guid,
          userPrincipalName: 'ada.lovelace@corp.example',
        },
      ]);

      const result = await service.detectOrphans('ad', 'test-tenant');

      const { aggregateId, payload } = emitted();
      expect(aggregateId).toBe(guid);
      expect(payload).toEqual({
        driftId: 'drift-123',
        targetSystem: 'ad',
        externalId: guid,
        accountIdentifier: guid,
        tenantId: 'test-tenant',
      });
      expect(driftService.saveDrift).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: guid,
          orphanDetails: expect.objectContaining({ externalId: guid }),
        }),
      );
      expect(result.orphans[0].externalId).toBe(guid);
      expect(JSON.stringify(payload)).not.toMatch(/Ada|Lovelace/);
    });
  });

  describe('an AD account an identity owns', () => {
    const guid = '33221100-5544-7766-8899-aabbccddeeff';
    const dn = 'CN=Ada Lovelace,OU=Users,DC=corp,DC=example';

    beforeEach(() => {
      connectorConfig.getConfig.mockResolvedValue({
        config: { host: 'ldap.corp.example', rootBaseDn: 'DC=corp,DC=example' },
      });
      adService.listUsers.mockResolvedValue([
        { id: dn, objectGuid: guid, userPrincipalName: 'a.lovelace@corp.example' },
      ]);
    });

    it.each([
      ['by its DN (provisioning write-back)', dn],
      ['by its objectGUID (an adopted orphan)', guid],
    ])('is no orphan when linked %s', async (_label, linkedKey) => {
      (identityService.findUserForReconciliation as jest.Mock).mockImplementation(
        async (key: string) => (key === linkedKey ? { _id: 'id-1', status: 'ACTIVE' } : null),
      );

      const result = await service.detectOrphans('ad', 'test-tenant');

      expect(result.orphans).toEqual([]);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  // An installed config orphan detection cannot list accounts with is an error for the system,
  // not "no accounts"
  it.each([
    ['ad', { rootBaseDn: 'DC=corp,DC=example' }, 'AD connector config is incomplete (empty: host)'],
    ['scim', { authType: 'bearer' }, 'SCIM connector config is incomplete (empty: baseUrl)'],
  ])(
    'rejects an installed %s config %j naming the missing setting',
    async (system, config, msg) => {
      connectorConfig.getConfig.mockResolvedValue({ config });

      await expect(service.detectOrphans(system, 'test-tenant')).rejects.toThrow(msg);
      expect(adService.listUsers).not.toHaveBeenCalled();
      expect(driftService.saveDrift).not.toHaveBeenCalled();
    },
  );

  it('finds no orphans in a system without an installed connector config', async () => {
    const result = await service.detectOrphans('ad', 'test-tenant');

    expect(result).toEqual({ orphans: [], driftRecords: [] });
    expect(adService.listUsers).not.toHaveBeenCalled();
  });

  it('should not flag as orphan when active Hub identity exists', async () => {
    (identityService.findUserForReconciliation as jest.Mock).mockResolvedValue({
      _id: 'id-1',
      email: 'orphan@example.com',
      status: 'ACTIVE',
    });

    const result = await service.detectOrphans('entra-id', 'test-tenant');

    expect(result.orphans).toHaveLength(0);
    expect(driftService.saveDrift).not.toHaveBeenCalled();
  });

  /**
   * A reconciliation run's excludedUsers (identity ids or emails) are never scanned or
   * corrected. Orphan detection is per target system: the account of an excluded user whose
   * identity was terminated (or is gone) would still be an orphan, recorded and later disabled
   * by its cleanup. Such an account is left alone, as the user is.
   */
  describe("the run's excludedUsers", () => {
    const leaver = { _id: '64b7f0c2a1b2c3d4e5f60718', status: 'TERMINATED' };

    it('leaves an orphan account alone whose UPN or mail is excluded, ignoring case', async () => {
      (identityService.findUserForReconciliation as jest.Mock).mockResolvedValue(null);

      const result = await service.detectOrphans('entra-id', 'test-tenant', ['Orphan@Example.com']);

      expect(result).toEqual({ orphans: [], driftRecords: [] });
      expect(driftService.saveDrift).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it("leaves an orphan account alone whose terminated identity's id is excluded", async () => {
      (identityService.findUserForReconciliation as jest.Mock).mockResolvedValue({
        ...leaver,
        email: 'orphan@example.com',
      });

      const result = await service.detectOrphans('entra-id', 'test-tenant', [leaver._id]);

      expect(result.driftRecords).toHaveLength(0);
      expect(driftService.saveDrift).not.toHaveBeenCalled();
    });

    it("leaves an orphan account alone whose terminated identity's email is excluded", async () => {
      (identityService.findUserForReconciliation as jest.Mock).mockResolvedValue({
        ...leaver,
        email: 'Grace.Hopper@example.com',
      });

      const result = await service.detectOrphans('entra-id', 'test-tenant', [
        'grace.hopper@example.com',
      ]);

      expect(result.driftRecords).toHaveLength(0);
      expect(driftService.saveDrift).not.toHaveBeenCalled();
    });

    it('records the orphan account of a user nobody excluded', async () => {
      (identityService.findUserForReconciliation as jest.Mock).mockResolvedValue({
        ...leaver,
        email: 'orphan@example.com',
      });

      const result = await service.detectOrphans('entra-id', 'test-tenant', [
        'ceo@example.com',
        '64b7f0c2a1b2c3d4e5f60799',
      ]);

      expect(result.driftRecords).toHaveLength(1);
      expect(driftService.saveDrift).toHaveBeenCalledTimes(1);
    });
  });
});
