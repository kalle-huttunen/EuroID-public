/**
 * Attribute controls, the one override of an HR-mastered department or job title
 * (PATCH /identity/v2/:id/controls; owner decision 2026-11-24). In-memory MongoDB, real
 * correlation, reconciliation and policy profile.
 *
 * The control replaced the profile's department at every reconcile, but the HR contract the
 * policies also evaluate followed HR's next value (metadata.manualOverrides matched only the value
 * the control replaced), so after an HR change the identity matched both departments again. The
 * control now drives the profile and the primary HR contract alike until it is removed or
 * expires; then the HR value returns and identity.updated starts the mover. Each set, removal and
 * expiry is audited.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { IdentityMutationService } from './identity-mutation.service';
import { IdentityQueryService } from './identity-query.service';
import { CONTROL_EXPIRY_ACTOR, IdentityControlsService } from './identity-controls.service';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationConfigUnavailableError } from '../correlation-config/correlation-config.errors';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import { AuditService } from '../audit/audit.service';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { EVENT_SCHEMAS } from '@infrastructure/events/event-payload-schemas';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import {
  closeTestDb,
  connectTestDb,
  createMockEventEmitter,
  createMockLoggerFactory,
  TEST_TENANT_ID,
  withTestTenant,
} from '@testing';

mongoose.plugin(tenantPlugin);

const HR = 'csv-hr';
const OPERATOR = 'op@corp.example';

const hrRow = (departmentName: string, jobTitle = 'Engineer'): StandardUserDto =>
  ({
    sourceSystem: HR,
    sourceUserId: 'E-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@corp.example',
    status: UserStatus.ACTIVE,
    jobTitle,
    departmentName,
  }) as StandardUserDto;

describe('Attribute controls: department and job title overrides (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let controls: IdentityControlsService;
  let mutation: IdentityMutationService;
  let onion: IdentityOnionService;
  let reconciliation: ReconciliationService;
  let identityModel: Model<IdentityDocument>;
  const events = createMockEventEmitter();
  const audit = { log: jest.fn().mockResolvedValue({}) };

  beforeAll(async () => {
    const uri = await connectTestDb();
    const { factory: loggerFactory } = createMockLoggerFactory();
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: LeaverPolicy.name, schema: LeaverPolicySchema },
        ]),
      ],
      providers: [
        IdentityCorrelationService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        IdentityControlsService,
        IdentityMutationService,
        IdentityQueryService,
        ReconciliationService,
        CorrelationRuleEngine,
        {
          provide: ReconciliationConfigService,
          useValue: {
            getConfig: async () => ({
              hrSourceTags: [HR],
              sourcePriorityOrder: [HR],
              contractCriticalFields: ['departmentName', 'jobTitle'],
              defaultMastery: {},
              targetIdKeys: [],
            }),
            getHrSourceTags: async () => [HR],
          },
        },
        {
          provide: CorrelationConfigService,
          useValue: {
            getCorrelationConfig: async () => ({
              rules: [{ strategy: 'email' }],
              conflictAction: 'review',
              confidenceThreshold: 0.7,
            }),
            getPrimaryHrSourceName: async () => HR,
            getHrPriorityConfig: async () => null,
            getHrPriorityFromBlueprint: async () => null,
            getHrConnectorsWithPriorityFromBlueprint: async () => [],
            getInstalledHrConnectorsWithPriority: async () => [],
            isHrSourceName: async (name: string) => name === HR,
          },
        },
        { provide: AuditService, useValue: audit },
        { provide: CorrelationHashService, useValue: { hash: (v: string) => `hash-${v}` } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    correlation = moduleRef.get(IdentityCorrelationService);
    controls = moduleRef.get(IdentityControlsService);
    mutation = moduleRef.get(IdentityMutationService);
    onion = moduleRef.get(IdentityOnionService);
    reconciliation = moduleRef.get(ReconciliationService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  /** What the policies evaluate for `attribute`: the profile's value and each HR contract's. */
  async function evaluated(id: string, attribute: 'department' | 'title'): Promise<string[]> {
    const identity = (await identityModel.findById(id).exec()) as IdentityDocument;
    const policyProfile = await onion.buildProfileWithContractsForPolicy(identity);
    const contracts = (policyProfile.contracts ?? []) as Array<Record<string, string>>;
    const field = attribute === 'department' ? 'departmentName' : 'jobTitle';
    return [String(policyProfile[field]), ...contracts.map((c) => c[attribute])];
  }

  /** The identity.updated payloads emitted, checked against the event's schema. */
  const updates = () =>
    events.emit.mock.calls
      .filter((call) => call[0] === DomainEventType.IDENTITY_UPDATED)
      .map((call) => EVENT_SCHEMAS[DomainEventType.IDENTITY_UPDATED]!.parse(call[2]));

  const audited = () =>
    audit.log.mock.calls.map(([entry]) => ({
      action: entry.action,
      actor: entry.actor,
      metadata: entry.payload?.metadata,
    }));

  async function ingest(departmentName: string, jobTitle?: string): Promise<string> {
    return String((await correlation.ensureIdentityFromUser(hrRow(departmentName, jobTitle)))!._id);
  }

  it('keeps the profile and the HR contract on the override when HR moves the person', async () =>
    await withTestTenant(async () => {
      const id = await ingest('Sales');
      jest.clearAllMocks();

      await controls.updateControls(
        id,
        { manualDepartment: 'R&D', reason: 'Reorg pilot' },
        OPERATOR,
      );

      expect(await evaluated(id, 'department')).toEqual(['R&D', 'R&D']);
      expect(updates()).toEqual([
        expect.objectContaining({
          identityId: id,
          changedFields: ['departmentName'],
          previousAttributes: { departmentName: 'Sales' },
          source: OPERATOR,
        }),
      ]);
      expect(audited()).toEqual([
        {
          action: 'IDENTITY_CONTROL_SET',
          actor: OPERATOR,
          metadata: { attribute: 'departmentName', reason: 'Reorg pilot' },
        },
      ]);

      // HR moves the person: the contract used to follow HR while the profile kept R&D
      await correlation.ensureIdentityFromUser(hrRow('Marketing'));
      expect(await evaluated(id, 'department')).toEqual(['R&D', 'R&D']);

      jest.clearAllMocks();
      await controls.updateControls(id, { manualDepartment: '' }, OPERATOR);

      // Removed: HR's current department everywhere, and the mover moves there
      expect(await evaluated(id, 'department')).toEqual(['Marketing', 'Marketing']);
      expect(updates()).toEqual([
        expect.objectContaining({ previousAttributes: { departmentName: 'R&D' } }),
      ]);
      expect(audited()).toEqual([
        {
          action: 'IDENTITY_CONTROL_REMOVED',
          actor: OPERATOR,
          metadata: { attribute: 'departmentName' },
        },
      ]);
      const stored = await identityModel.findById(id).lean().exec();
      expect(stored!.controls.manualDepartment).toBeUndefined();
      expect(stored!.controls.manualDepartmentInfo).toBeUndefined();
      expect(stored!.metadata?.manualOverrides).toBeUndefined();
    }));

  it('overrides the job title the same way', async () =>
    await withTestTenant(async () => {
      const id = await ingest('Sales', 'Engineer');
      jest.clearAllMocks();

      await controls.updateControls(
        id,
        { manualJobTitle: 'Interim lead', reason: 'Covering a leave' },
        OPERATOR,
      );
      await correlation.ensureIdentityFromUser(hrRow('Sales', 'Senior engineer'));

      expect(await evaluated(id, 'title')).toEqual(['Interim lead', 'Interim lead']);
      expect(updates()).toEqual([
        expect.objectContaining({
          changedFields: ['jobTitle'],
          previousAttributes: { jobTitle: 'Engineer' },
        }),
      ]);
    }));

  it('ends an expired override at the sweep: the HR value returns and the mover runs', async () =>
    await withTestTenant(async () => {
      const id = await ingest('Sales');
      const expiresAt = new Date(Date.now() + 3_600_000);
      await controls.updateControls(
        id,
        { manualDepartment: 'R&D', reason: 'Two-week pilot', expiresAt: expiresAt.toISOString() },
        OPERATOR,
      );
      await correlation.ensureIdentityFromUser(hrRow('Marketing'));
      jest.clearAllMocks();

      // Not yet expired: the sweep leaves it
      expect(await controls.endExpiredControls(TEST_TENANT_ID, new Date(), 50)).toBe(0);
      expect(await evaluated(id, 'department')).toEqual(['R&D', 'R&D']);

      const later = new Date(expiresAt.getTime() + 60_000);
      expect(await controls.endExpiredControls(TEST_TENANT_ID, later, 50)).toBe(1);

      expect(await evaluated(id, 'department')).toEqual(['Marketing', 'Marketing']);
      expect(updates()).toEqual([
        expect.objectContaining({
          changedFields: ['departmentName'],
          previousAttributes: { departmentName: 'R&D' },
          source: CONTROL_EXPIRY_ACTOR,
        }),
      ]);
      expect(audited()).toEqual([
        {
          action: 'IDENTITY_CONTROL_EXPIRED',
          actor: CONTROL_EXPIRY_ACTOR,
          metadata: { attribute: 'departmentName' },
        },
      ]);
      // Ended once: the next sweep finds nothing
      expect(await controls.endExpiredControls(TEST_TENANT_ID, later, 50)).toBe(0);
    }));

  it('starts nothing for a control that changes no department (the kill switch)', async () =>
    await withTestTenant(async () => {
      const id = await ingest('Sales');
      jest.clearAllMocks();

      await controls.updateControls(id, { isLoginDisabled: true }, OPERATOR);

      expect(updates()).toEqual([]);
      // Hunt 2026-11-25 02 F18: the kill switch was not audited
      expect(audited()).toEqual([
        { action: 'IDENTITY_LOGIN_DISABLED', actor: OPERATOR, metadata: undefined },
      ]);
      expect(await evaluated(id, 'department')).toEqual(['Sales', 'Sales']);
      const stored = await identityModel.findById(id).lean().exec();
      expect(stored!.profile.status).toBe(UserStatus.SUSPENDED);
    }));

  // Hunt 2026-11-25 02 F6: a target source only fills the status, so the stored SUSPENDED stayed
  it('gives a non-HR identity its status back when the kill switch is turned off', async () =>
    await withTestTenant(async () => {
      const id = String(
        (await correlation.ensureIdentityFromUser({
          ...hrRow('Sales'),
          sourceSystem: 'manual-ui',
          sourceUserId: 'm-1',
          status: UserStatus.ACTIVE,
        }))!._id,
      );

      await controls.updateControls(id, { isLoginDisabled: true }, OPERATOR);
      // A sync while the switch is on keeps it SUSPENDED
      await correlation.ensureIdentityFromUser({
        ...hrRow('Sales'),
        sourceSystem: 'manual-ui',
        sourceUserId: 'm-1',
        status: UserStatus.ACTIVE,
      });
      expect((await identityModel.findById(id).lean().exec())!.profile.status).toBe(
        UserStatus.SUSPENDED,
      );

      await controls.updateControls(id, { isLoginDisabled: false }, OPERATOR);
      const stored = await identityModel.findById(id).lean().exec();
      expect(stored!.profile.status).toBe(UserStatus.ACTIVE);
      expect(stored!.metadata).not.toHaveProperty('statusUnderKillSwitch');
    }));

  it('keeps a status set before the kill switch when it is turned off', async () =>
    await withTestTenant(async () => {
      const id = String(
        (await correlation.ensureIdentityFromUser({
          ...hrRow('Sales'),
          sourceSystem: 'manual-ui',
          sourceUserId: 'm-1',
          status: UserStatus.INACTIVE,
        }))!._id,
      );

      await controls.updateControls(id, { isLoginDisabled: true });
      await controls.updateControls(id, { isLoginDisabled: false });

      expect((await identityModel.findById(id).lean().exec())!.profile.status).toBe(
        UserStatus.INACTIVE,
      );
    }));

  // Hunt 2026-11-25 follow-up of 02 F6: a PATCH of the status while the switch was on lifted the
  // suspension until the next reconcile, which then kept the status from before the PATCH
  it('keeps the identity SUSPENDED under the switch and gives it the PATCHed status at release', async () =>
    await withTestTenant(async () => {
      const id = String(
        (await correlation.ensureIdentityFromUser({
          ...hrRow('Sales'),
          sourceSystem: 'manual-ui',
          sourceUserId: 'm-1',
          status: UserStatus.ACTIVE,
        }))!._id,
      );
      await controls.updateControls(id, { isLoginDisabled: true }, OPERATOR);

      await mutation.update(id, { status: UserStatus.INACTIVE }, OPERATOR);
      let stored = await identityModel.findById(id).lean().exec();
      expect(stored!.profile.status).toBe(UserStatus.SUSPENDED);
      expect(stored!.metadata?.statusUnderKillSwitch).toBe(UserStatus.INACTIVE);

      // A sync while the switch is on keeps both
      await correlation.ensureIdentityFromUser({
        ...hrRow('Sales'),
        sourceSystem: 'manual-ui',
        sourceUserId: 'm-1',
      });
      stored = await identityModel.findById(id).lean().exec();
      expect(stored!.profile.status).toBe(UserStatus.SUSPENDED);
      expect(stored!.metadata?.statusUnderKillSwitch).toBe(UserStatus.INACTIVE);

      await controls.updateControls(id, { isLoginDisabled: false }, OPERATOR);
      stored = await identityModel.findById(id).lean().exec();
      expect(stored!.profile.status).toBe(UserStatus.INACTIVE);
    }));

  it('reports no status change while the switch is on and the PATCH changes only the kept status', async () =>
    await withTestTenant(async () => {
      const id = String(
        (await correlation.ensureIdentityFromUser({
          ...hrRow('Sales'),
          sourceSystem: 'manual-ui',
          sourceUserId: 'm-1',
          status: UserStatus.ACTIVE,
        }))!._id,
      );
      await controls.updateControls(id, { isLoginDisabled: true }, OPERATOR);
      jest.clearAllMocks();

      const result = await mutation.updateWithChanges(
        id,
        { status: UserStatus.INACTIVE },
        OPERATOR,
      );
      expect(result.changedFields).toEqual(['status']);
      // The profile still says SUSPENDED: identity.updated names the status as written
      expect(events.emit).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_UPDATED,
        id,
        expect.objectContaining({ changedFields: ['status'] }),
        expect.anything(),
      );
      // The same status again changes nothing
      jest.clearAllMocks();
      const again = await mutation.updateWithChanges(id, { status: UserStatus.INACTIVE }, OPERATOR);
      expect(again.changedFields).toEqual([]);
      expect(events.emit).not.toHaveBeenCalledWith(
        DomainEventType.IDENTITY_UPDATED,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    }));

  it('audits turning the kill switch off, and a request that changes it not at all', async () =>
    await withTestTenant(async () => {
      const id = await ingest('Sales');
      await controls.updateControls(id, { isLoginDisabled: true }, OPERATOR);
      jest.clearAllMocks();

      await controls.updateControls(id, { isLoginDisabled: true }, OPERATOR);
      expect(audited()).toEqual([]);
      await controls.updateControls(id, { isLoginDisabled: false }, OPERATOR);
      expect(audited()).toEqual([
        { action: 'IDENTITY_LOGIN_ENABLED', actor: OPERATOR, metadata: undefined },
      ]);
    }));

  // Hunt 2026-11-25 r2-02 N2: defaults would reconcile without the field mastery overrides
  it('changes nothing when the correlation settings cannot be read', async () =>
    await withTestTenant(async () => {
      const id = await ingest('Sales');
      const settings = moduleRef.get(CorrelationConfigService);
      const read = settings.getCorrelationConfig.bind(settings);
      jest
        .spyOn(settings, 'getCorrelationConfig')
        .mockImplementation(async (tenantId: string, options?: { strict?: boolean }) => {
          if (options?.strict) throw new CorrelationConfigUnavailableError();
          return read(tenantId, options);
        });

      await expect(
        controls.updateControls(id, { isLoginDisabled: true }, OPERATOR),
      ).rejects.toBeInstanceOf(CorrelationConfigUnavailableError);
      const stored = await identityModel.findById(id).lean().exec();
      expect(stored!.controls.isLoginDisabled).toBe(false);
      expect(stored!.profile.status).toBe(UserStatus.ACTIVE);
    }));

  describe('the email override (hunt 2026-11-25 02 F5, F18)', () => {
    const otherRow = {
      ...hrRow('Sales'),
      sourceUserId: 'E-2',
      email: 'grace@corp.example',
      firstName: 'Grace',
    } as StandardUserDto;

    it('becomes the profile email lower-cased, and its set and removal are audited masked', async () =>
      await withTestTenant(async () => {
        const id = await ingest('Sales');

        await controls.updateControls(id, { overrides: { email: 'ada.l@corp.example' } }, OPERATOR);
        expect((await identityModel.findById(id).lean().exec())!.profile.email).toBe(
          'ada.l@corp.example',
        );
        await controls.updateControls(id, { overrides: { email: '' } }, OPERATOR);
        const stored = await identityModel.findById(id).lean().exec();
        expect(stored!.profile.email).toBe('ada@corp.example');
        expect(stored!.controls.overrides?.email).toBeUndefined();

        const entries = audit.log.mock.calls.map(([entry]) => entry);
        expect(entries.map((e) => [e.action, e.actor])).toEqual([
          ['IDENTITY_EMAIL_OVERRIDE_SET', OPERATOR],
          ['IDENTITY_EMAIL_OVERRIDE_REMOVED', OPERATOR],
        ]);
        expect(JSON.stringify(entries)).not.toContain('ada.l@corp.example');
      }));

    it('refuses (409) an email another live identity has, and stores nothing', async () =>
      await withTestTenant(async () => {
        const id = await ingest('Sales');
        await correlation.ensureIdentityFromUser(otherRow);
        jest.clearAllMocks();

        await expect(
          controls.updateControls(id, { overrides: { email: 'grace@corp.example' } }, OPERATOR),
        ).rejects.toBeInstanceOf(ConflictException);

        const stored = await identityModel.findById(id).lean().exec();
        expect(stored!.controls.overrides?.email).toBeUndefined();
        expect(stored!.profile.email).toBe('ada@corp.example');
        expect(audited()).toEqual([]);
      }));

    it('stores neither the controls nor the profile when the reconcile save is refused', async () =>
      await withTestTenant(async () => {
        const id = await ingest('Sales');
        // Another identity takes the address between the check and the save
        const taken = Object.assign(new Error('E11000 duplicate key error'), {
          code: 11000,
          keyPattern: { tenantId: 1, 'profile.email': 1 },
        });
        jest.spyOn(reconciliation, 'reconcile').mockRejectedValueOnce(taken);

        await expect(
          controls.updateControls(id, { overrides: { email: 'new@corp.example' } }, OPERATOR),
        ).rejects.toBeInstanceOf(ConflictException);

        const stored = await identityModel.findById(id).lean().exec();
        expect(stored!.controls.overrides?.email).toBeUndefined();
      }));
  });

  it('answers null for an identity that does not exist', async () =>
    await withTestTenant(async () => {
      expect(
        await controls.updateControls(String(new mongoose.Types.ObjectId()), {
          isLoginDisabled: true,
        }),
      ).toBeNull();
    }));

  it('reports the HR-mastered fields and the active override for the identity page', async () =>
    await withTestTenant(async () => {
      const id = await ingest('Sales');
      await controls.updateControls(id, { manualDepartment: 'R&D', reason: 'Pilot' }, OPERATOR);

      const mastery = await controls.getMastery(id);

      expect(mastery?.masteredBy).toMatchObject({
        departmentName: HR,
        jobTitle: HR,
        email: HR,
        firstName: HR,
      });
      expect(mastery?.masteredBy).not.toHaveProperty('preferredName');
      expect(mastery?.attributeControls).toEqual({
        departmentName: expect.objectContaining({
          value: 'R&D',
          reason: 'Pilot',
          setBy: OPERATOR,
        }),
      });
    }));
});
