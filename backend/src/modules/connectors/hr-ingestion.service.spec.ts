import { Test, TestingModule } from '@nestjs/testing';
import { Logger, NotFoundException } from '@nestjs/common';
import { HrIngestionService, IngestResult } from './hr-ingestion.service';
import { ConnectorConfigService } from './connector-config.service';
import { IdentityService } from '../identity/identity.service';
import { CsvHrService } from './csv-hr-connector/csv-hr.service';
import { JsonApiHrService } from './json-api-hr-connector/json-api-hr.service';
import { PluginRegistryService } from './plugin/plugin-registry.service';
import { BlueprintsService } from '../blueprints/blueprints.service';
import { createMockUser } from '../../testing/mock-factories';
import { TEST_TENANT_ID, createMockEventEmitter } from '../../testing/test-helpers';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import type { LeaverSyncSummary } from '@shared/interfaces/leaver-sync';
import type { MoverSyncSummary } from '@shared/interfaces/mover-sync';
import type { JoinerSyncSummary } from '@shared/interfaces/joiner-sync';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { DeletedIdentityRowIgnored } from '../identity/deleted-identity-rows';
import { RowHeldForConflictReview } from '../identity/conflict-held-rows';
import { IdentityLimitReached } from '../identity/identity-limit';
import { CorrelationConfigUnavailableError } from '../correlation-config/correlation-config.errors';
import type { HrFetchStats } from './hr/hr-lifecycle-fields';

describe('HrIngestionService', () => {
  let service: HrIngestionService;
  let connectorConfigService: { getConfig: jest.Mock };
  let identityService: { saveOrUpdate: jest.Mock };
  let csvHrService: Record<string, unknown>;
  let jsonApiHrService: Record<string, unknown>;
  let pluginRegistry: { getById: jest.Mock };
  let blueprintsService: { getLatestBlueprint: jest.Mock };
  let eventEmitter: ReturnType<typeof createMockEventEmitter>;

  beforeEach(async () => {
    connectorConfigService = {
      getConfig: jest.fn(),
    };

    identityService = {
      saveOrUpdate: jest.fn(),
    };

    csvHrService = {
      sourceName: 'csv-hr',
      fetchUsers: jest.fn(),
      healthCheck: jest.fn(),
      updateUserFields: jest.fn(),
      writeBackCapableFields: [] as string[],
    };

    jsonApiHrService = {
      sourceName: 'json-api-hr',
      fetchUsers: jest.fn(),
      healthCheck: jest.fn(),
      updateUserFields: jest.fn(),
      writeBackCapableFields: [] as string[],
    };

    pluginRegistry = {
      getById: jest.fn(),
    };

    blueprintsService = {
      getLatestBlueprint: jest.fn(),
    };

    eventEmitter = createMockEventEmitter();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HrIngestionService,
        { provide: ConnectorConfigService, useValue: connectorConfigService },
        { provide: IdentityService, useValue: identityService },
        { provide: CsvHrService, useValue: csvHrService },
        { provide: JsonApiHrService, useValue: jsonApiHrService },
        { provide: PluginRegistryService, useValue: pluginRegistry },
        { provide: BlueprintsService, useValue: blueprintsService },
        { provide: DomainEventEmitterService, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<HrIngestionService>(HrIngestionService);
  });

  // ── Helpers ───────────────────────────────────────────────────────────

  /** Returns a minimal manifest stub with the given id and capabilities. */
  function makeManifest(id: string, capabilities: string[] = ['ingest']) {
    return {
      id,
      name: id,
      version: '1.0.0',
      description: 'test',
      capabilities,
      configSchema: [],
      module: id,
    };
  }

  /** Returns a valid partial StandardUserDto that passes Zod validation. */
  function makeHrUser(overrides: Record<string, unknown> = {}) {
    return {
      sourceSystem: 'csv-hr',
      sourceUserId: 'EMP-100',
      email: 'new.hire@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
      status: UserStatus.ACTIVE,
      ...overrides,
    };
  }

  // ── ingestFromConnector ───────────────────────────────────────────────

  describe('ingestFromConnector', () => {
    it('should create a new identity via saveOrUpdate for a new hire', async () => {
      const hrUser = makeHrUser();

      pluginRegistry.getById.mockReturnValue(makeManifest('csv-hr') as never);
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([hrUser]);
      identityService.saveOrUpdate.mockResolvedValue(
        createMockUser({ email: hrUser.email }) as never,
      );

      const result: IngestResult = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result.ingested).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(identityService.saveOrUpdate).toHaveBeenCalledTimes(1);

      const savedDto = (identityService.saveOrUpdate as jest.Mock).mock.calls[0][0];
      expect(savedDto.email).toBe('new.hire@example.com');
      expect(savedDto.firstName).toBe('Alice');
      expect(savedDto.tenantId).toBe(TEST_TENANT_ID);
    });

    describe('identity.created for the identity a row mints (the joiner timeline starts there)', () => {
      const ingest = async (minted: boolean) => {
        pluginRegistry.getById.mockReturnValue(makeManifest('csv-hr') as never);
        connectorConfigService.getConfig.mockResolvedValue({
          config: { filePath: '/data/hr.csv' },
        } as never);
        (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([makeHrUser()]);
        // Correlation tells the hub write who it writes to: null before it mints one
        identityService.saveOrUpdate.mockImplementation(
          async (_dto: unknown, _session: unknown, beforeWrite: (s: unknown) => Promise<void>) => {
            await beforeWrite(minted ? null : { profile: {} });
            return createMockUser({ _id: 'id-new', email: 'new.hire@example.com' });
          },
        );
        return service.ingestFromConnector('csv-hr', TEST_TENANT_ID);
      };
      const created = () =>
        eventEmitter.emit.mock.calls.filter(([type]) => type === DomainEventType.IDENTITY_CREATED);

      it('goes out under the new identity id, with the source and no personal data', async () => {
        await ingest(true);

        expect(created()).toEqual([
          [
            DomainEventType.IDENTITY_CREATED,
            'id-new',
            { identityId: 'id-new', sourceSystem: 'csv-hr', status: 'ACTIVE' },
            { tenantId: TEST_TENANT_ID },
          ],
        ]);
        const payload = created()[0][2];
        expect(EVENT_SCHEMAS[DomainEventType.IDENTITY_CREATED]!.parse(payload)).toEqual(payload);
      });

      it('does not go out for a row that updated an identity', async () => {
        await ingest(false);

        expect(created()).toEqual([]);
      });
    });

    it('should update an existing employee linked account via saveOrUpdate', async () => {
      const existingUser = makeHrUser({
        sourceUserId: 'EMP-001',
        email: 'john.doe@example.com',
        firstName: 'John',
        lastName: 'Doe',
        jobTitle: 'Senior Engineer',
      });

      pluginRegistry.getById.mockReturnValue(makeManifest('csv-hr') as never);
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([existingUser]);
      identityService.saveOrUpdate.mockResolvedValue(
        createMockUser({
          sourceUserId: 'EMP-001',
          email: 'john.doe@example.com',
          jobTitle: 'Senior Engineer',
        }) as never,
      );

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result.ingested).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(identityService.saveOrUpdate).toHaveBeenCalledTimes(1);

      const savedDto = (identityService.saveOrUpdate as jest.Mock).mock.calls[0][0];
      expect(savedDto.sourceUserId).toBe('EMP-001');
      expect(savedDto.jobTitle).toBe('Senior Engineer');
    });

    it('should throw NotFoundException when connector is not installed (no manifest)', async () => {
      pluginRegistry.getById.mockReturnValue(undefined);

      await expect(
        service.ingestFromConnector('unknown-connector', TEST_TENANT_ID),
      ).rejects.toThrow(NotFoundException);
      expect(identityService.saveOrUpdate).not.toHaveBeenCalled();
    });

    it('should collect malformed HR data as errors without crashing (partial success)', async () => {
      const validUser = makeHrUser({ sourceUserId: 'EMP-200', email: 'valid@example.com' });
      // Malformed user: missing email and sourceUserId causes buildFullDto to throw
      const malformedUser = { firstName: 'Bad', lastName: 'Record' };

      pluginRegistry.getById.mockReturnValue(makeManifest('csv-hr') as never);
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([malformedUser, validUser]);
      identityService.saveOrUpdate.mockResolvedValue(
        createMockUser({ email: 'valid@example.com' }) as never,
      );

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result.ingested).toBe(1);
      expect(result.errors).toHaveLength(1);
      // No sourceRows from the connector: the row is its position in the fetched feed
      expect(result.errors[0]).toBe('Row 1: Missing sourceUserId or email');
      // The valid user should still have been saved
      expect(identityService.saveOrUpdate).toHaveBeenCalledTimes(1);
    });

    it('names a failed row by its source row and masked email, in errors and in logs', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      pluginRegistry.getById.mockReturnValue(makeManifest('csv-hr') as never);
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockImplementation(
        async (_config: unknown, _tenantId: unknown, stats: HrFetchStats) => {
          // The connector skipped the lines in between: these users came from CSV lines 4 and 7
          stats.sourceRows?.push(4, 7);
          return [
            makeHrUser({ sourceUserId: 'E-4', email: 'vera.valid@example.com', status: 'GONE' }),
            makeHrUser({ sourceUserId: 'E-7', email: 'dup.person@example.com' }),
          ];
        },
      );
      identityService.saveOrUpdate.mockRejectedValue(
        new Error('E11000 duplicate key error dup key: { email: "dup.person@example.com" }'),
      );

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toMatch(/^Row 4 \(v•••@example\.com\): status: /);
      expect(result.errors[1]).toBe(
        'Row 7 (d•••@example.com): E11000 duplicate key error dup key: { email: "d•••@example.com" }',
      );
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('Row 4 (v•••@example.com) failed validation');
      expect(logged).toContain('Row 7 (d•••@example.com) could not be saved');
      for (const text of [...result.errors, logged]) {
        expect(text).not.toContain('vera.valid@example.com');
        expect(text).not.toContain('dup.person@example.com');
      }
      warn.mockRestore();
    });

    // A row that cannot be correlated safely (the settings naming the national ID field to
    // remove could not be read) fails the whole run, so the activity retries it, instead of
    // being counted as one bad row while the next rows hit the same failure
    it('fails the ingest when the correlation settings cannot be read', async () => {
      pluginRegistry.getById.mockReturnValue(makeManifest('csv-hr') as never);
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([
        makeHrUser({ sourceUserId: 'E-1', email: 'a@example.com' }),
        makeHrUser({ sourceUserId: 'E-2', email: 'b@example.com' }),
      ]);
      identityService.saveOrUpdate.mockRejectedValue(new CorrelationConfigUnavailableError());

      await expect(service.ingestFromConnector('csv-hr', TEST_TENANT_ID)).rejects.toBeInstanceOf(
        CorrelationConfigUnavailableError,
      );
      expect(identityService.saveOrUpdate).toHaveBeenCalledTimes(1);
      // No run report: leaver detection must not see a run that stored nothing
      expect(eventEmitter.emitAndWait).not.toHaveBeenCalled();
    });

    it('should return ingested=0 when connector returns empty result', async () => {
      pluginRegistry.getById.mockReturnValue(makeManifest('csv-hr') as never);
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/empty.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([]);

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result.ingested).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(identityService.saveOrUpdate).not.toHaveBeenCalled();
    });
  });

  // ── HR_SYNC_COMPLETED (leaver detection), then HR_SYNC_MOVERS_REQUESTED, HR_SYNC_JOINERS_REQUESTED

  describe('sync run report for leaver, mover and joiner detection', () => {
    const summary: LeaverSyncSummary = {
      kind: 'leaver-sync-summary',
      sourceName: 'csv-hr',
      fullSync: true,
      detected: 2,
      started: 2,
    };
    const joiners: JoinerSyncSummary = {
      kind: 'joiner-sync-summary',
      sourceName: 'csv-hr',
      fullSync: true,
      detected: 1,
      started: 1,
      pending: 0,
      waiting: 0,
      startFailed: 0,
      closed: 0,
      pipelineStatus: 'DEPLOYED',
    };

    beforeEach(() => {
      pluginRegistry.getById.mockReturnValue(makeManifest('csv-hr') as never);
      identityService.saveOrUpdate.mockResolvedValue(createMockUser() as never);
    });

    it('reports the run with counts only and returns the leaver summary', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockImplementation(
        async (_config: unknown, _tenant: unknown, stats: { skipped: number }) => {
          stats.skipped = 1;
          return [makeHrUser()];
        },
      );
      // Other listeners (audit, realtime) return non-summary values.
      eventEmitter.emitAndWait.mockResolvedValueOnce([undefined, summary]);

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result.leavers).toEqual(summary);
      const [type, aggregateId, payload, options] = eventEmitter.emitAndWait.mock.calls[0];
      expect(type).toBe(DomainEventType.HR_SYNC_COMPLETED);
      expect(aggregateId).toBe('csv-hr');
      expect(options).toEqual({ tenantId: TEST_TENANT_ID });
      expect(payload).toEqual(
        expect.objectContaining({
          connectorName: 'csv-hr',
          sourceName: 'csv-hr',
          fetched: 1,
          skipped: 1,
          ingested: 1,
          errorCount: 0,
        }),
      );
      // No per-person data leaves the ingest in the event.
      expect(JSON.stringify(payload)).not.toContain('new.hire@example.com');
    });

    it('names the source as identity correlation stores it (configured sourceSystem)', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv', sourceSystem: 'Finance HR' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([makeHrUser()]);

      await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(eventEmitter.emitAndWait.mock.calls[0][2]).toEqual(
        expect.objectContaining({ sourceName: 'finance-hr' }),
      );
    });

    it('keeps the ingest result and asks for no movers or joiners when leaver detection fails', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([makeHrUser()]);
      eventEmitter.emitAndWait.mockRejectedValue(new Error('mongo down'));

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result).toEqual({
        ingested: 1,
        errors: [],
        activeRowsOfDeletedIdentities: 0,
        rowsHeldForConflictReview: 0,
        rowsHeldForIdentityLimit: 0,
      });
      // Mover and joiner detection must not run without this run's leavers known.
      expect(eventEmitter.emitAndWait).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emitAndWait.mock.calls[0][0]).toBe(DomainEventType.HR_SYNC_COMPLETED);
    });

    it('asks for mover detection after leaver detection, with the same run, and returns its summary', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([makeHrUser()]);
      const movers: MoverSyncSummary = {
        kind: 'mover-sync-summary',
        sourceName: 'csv-hr',
        fullSync: true,
        detected: 1,
        started: 1,
        alreadyRunning: 0,
        startFailed: 0,
        withoutBaseline: 0,
      };
      const order: string[] = [];
      eventEmitter.emitAndWait.mockImplementation(async (type: DomainEventType) => {
        order.push(type);
        return type === DomainEventType.HR_SYNC_COMPLETED ? [summary] : [undefined, movers];
      });

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(order).toEqual([
        DomainEventType.HR_SYNC_COMPLETED,
        DomainEventType.HR_SYNC_MOVERS_REQUESTED,
        DomainEventType.HR_SYNC_JOINERS_REQUESTED,
      ]);
      const [first, second] = eventEmitter.emitAndWait.mock.calls;
      expect(second[1]).toBe('csv-hr');
      expect(second[2]).toEqual(first[2]);
      expect(second[3]).toEqual({ tenantId: TEST_TENANT_ID });
      expect(result).toEqual({
        ingested: 1,
        errors: [],
        activeRowsOfDeletedIdentities: 0,
        rowsHeldForConflictReview: 0,
        rowsHeldForIdentityLimit: 0,
        leavers: summary,
        movers,
      });
    });

    it('keeps the ingest result when mover detection fails, and still asks for joiners', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([makeHrUser()]);
      eventEmitter.emitAndWait
        .mockResolvedValueOnce([summary])
        .mockRejectedValueOnce(new Error('mongo down'))
        .mockResolvedValueOnce([joiners]);

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result).toEqual({
        ingested: 1,
        errors: [],
        activeRowsOfDeletedIdentities: 0,
        rowsHeldForConflictReview: 0,
        rowsHeldForIdentityLimit: 0,
        leavers: summary,
        joiners,
      });
      expect(eventEmitter.emitAndWait.mock.calls[2][0]).toBe(
        DomainEventType.HR_SYNC_JOINERS_REQUESTED,
      );
    });

    it('asks for joiner detection last, with the same run, and returns its summary', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([makeHrUser()]);
      eventEmitter.emitAndWait.mockImplementation(async (type: DomainEventType) =>
        type === DomainEventType.HR_SYNC_COMPLETED
          ? [summary]
          : type === DomainEventType.HR_SYNC_JOINERS_REQUESTED
            ? [undefined, joiners]
            : [],
      );

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      const calls = eventEmitter.emitAndWait.mock.calls;
      expect(calls.map(([type]) => type)).toEqual([
        DomainEventType.HR_SYNC_COMPLETED,
        DomainEventType.HR_SYNC_MOVERS_REQUESTED,
        DomainEventType.HR_SYNC_JOINERS_REQUESTED,
      ]);
      expect(calls[2][1]).toBe('csv-hr');
      expect(calls[2][2]).toEqual(calls[0][2]);
      expect(calls[2][3]).toEqual({ tenantId: TEST_TENANT_ID });
      expect(result.joiners).toEqual(joiners);
      expect(result.movers).toBeUndefined();
    });

    it('keeps the ingest result when joiner detection fails', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([makeHrUser()]);
      eventEmitter.emitAndWait
        .mockResolvedValueOnce([summary])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('mongo down'));

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result).toEqual({
        ingested: 1,
        errors: [],
        activeRowsOfDeletedIdentities: 0,
        rowsHeldForConflictReview: 0,
        rowsHeldForIdentityLimit: 0,
        leavers: summary,
      });
    });

    it('counts rows of deleted identities apart: neither ingested nor errors, the run stays full', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([
        makeHrUser({ sourceUserId: 'E-1', email: 'left@example.com' }),
        makeHrUser({ sourceUserId: 'E-2', email: 'deleted.active@example.com' }),
        makeHrUser({ sourceUserId: 'E-3' }),
      ]);
      identityService.saveOrUpdate
        .mockRejectedValueOnce(new DeletedIdentityRowIgnored('id-1', 'ended'))
        .mockRejectedValueOnce(new DeletedIdentityRowIgnored('id-2', 'not-rehire'))
        .mockResolvedValueOnce(createMockUser() as never);

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result).toMatchObject({ ingested: 1, errors: [], activeRowsOfDeletedIdentities: 1 });
      const payload = eventEmitter.emitAndWait.mock.calls[0][2];
      expect(payload).toMatchObject({ fetched: 3, skipped: 0, ingested: 1, errorCount: 0 });
    });

    it('counts rows held on a correlation conflict apart: neither ingested nor errors', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([
        makeHrUser({ sourceUserId: 'E-1', email: 'shared@example.com' }),
        makeHrUser({ sourceUserId: 'E-2' }),
      ]);
      identityService.saveOrUpdate
        .mockRejectedValueOnce(new RowHeldForConflictReview('id-1'))
        .mockResolvedValueOnce(createMockUser() as never);

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result).toMatchObject({ ingested: 1, errors: [], rowsHeldForConflictReview: 1 });
      const payload = eventEmitter.emitAndWait.mock.calls[0][2];
      expect(payload).toMatchObject({ fetched: 2, ingested: 1, errorCount: 0 });
    });

    // A person past the tenant's identity limit is not dropped as an error: the row is held,
    // counted with the limit, and the next sync after the limit is raised ingests it.
    it('holds rows past the identity limit apart, naming the limit: neither ingested nor errors', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockResolvedValue([
        makeHrUser({ sourceUserId: 'E-1' }),
        makeHrUser({ sourceUserId: 'E-2', email: 'new.one@example.com' }),
        makeHrUser({ sourceUserId: 'E-3', email: 'new.two@example.com' }),
      ]);
      identityService.saveOrUpdate
        .mockResolvedValueOnce(createMockUser() as never)
        .mockRejectedValueOnce(new IdentityLimitReached(500))
        .mockRejectedValueOnce(new IdentityLimitReached(500));

      const result = await service.ingestFromConnector('csv-hr', TEST_TENANT_ID);

      expect(result).toMatchObject({
        ingested: 1,
        errors: [],
        rowsHeldForIdentityLimit: 2,
        identityLimit: 500,
      });
      const payload = eventEmitter.emitAndWait.mock.calls[0][2];
      expect(payload).toMatchObject({ fetched: 3, ingested: 1, errorCount: 0 });
    });

    it('reports nothing when the feed cannot be fetched (a failed sync)', async () => {
      connectorConfigService.getConfig.mockResolvedValue({
        config: { filePath: '/data/hr.csv' },
      } as never);
      (csvHrService.fetchUsers as jest.Mock).mockRejectedValue(new Error('file missing'));

      await expect(service.ingestFromConnector('csv-hr', TEST_TENANT_ID)).rejects.toThrow(
        'file missing',
      );
      expect(eventEmitter.emitAndWait).not.toHaveBeenCalled();
    });
  });

  // ── getHrConnectorWithWriteBack ───────────────────────────────────────

  describe('getHrConnectorWithWriteBack', () => {
    it('should return null for read-only connectors (csv-hr)', () => {
      // The guard checks: typeof wb.updateUserFields === 'function'
      // && Array.isArray(wb.writeBackCapableFields).
      // A read-only connector that does not expose these properties should
      // cause the method to return null.
      const readOnlyMock = {
        sourceName: 'csv-hr',
        fetchUsers: jest.fn(),
        // Deliberately omitting updateUserFields and writeBackCapableFields
      };

      const localService = new HrIngestionService(
        connectorConfigService as unknown as ConnectorConfigService,
        identityService as unknown as IdentityService,
        readOnlyMock as unknown as CsvHrService,
        jsonApiHrService as unknown as JsonApiHrService,
        pluginRegistry as unknown as PluginRegistryService,
        blueprintsService as unknown as BlueprintsService,
        eventEmitter as unknown as DomainEventEmitterService,
      );

      const result = localService.getHrConnectorWithWriteBack('csv-hr');
      expect(result).toBeNull();
    });

    it('should return null for unrecognized connector names', () => {
      const result = service.getHrConnectorWithWriteBack('workday');
      expect(result).toBeNull();
    });
  });
});
