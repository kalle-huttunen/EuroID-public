/**
 * HR rows of soft-deleted identities (in-memory MongoDB with the identity indexes, real
 * correlation rules and reconciliation): a row never mints a second identity. A terminated or
 * ended row changes nothing; an active row starting after the deletion is a rehire that revives
 * the identity; any other active row changes nothing and is reported.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { DeletedIdentityRowIgnored } from './deleted-identity-rows';
import { RowHeldForConflictReview } from './conflict-held-rows';
import { Identity, IdentitySchema, IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import {
  createMockLoggerFactory,
  createMockEventEmitter,
  withTestTenant,
  TEST_TENANT_ID,
} from '@testing';

mongoose.plugin(tenantPlugin);

const HR = 'csv-hr';
const EMAIL = 'ada@corp.example';
const DELETED_AT = new Date('2026-06-01T10:00:00Z');

function hrRow(extra: Partial<StandardUserDto> = {}): StandardUserDto {
  return {
    sourceSystem: HR,
    sourceUserId: 'E-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: EMAIL,
    status: UserStatus.ACTIVE,
    startDate: new Date('2020-01-01'),
    ...extra,
  } as StandardUserDto;
}

describe('HR rows of soft-deleted identities (MongoDB)', () => {
  let moduleRef: TestingModule;
  let correlation: IdentityCorrelationService;
  let identityModel: Model<IdentityDocument>;
  let policyModel: Model<LeaverPolicy>;
  const events = createMockEventEmitter();
  const { factory: loggerFactory, logger } = createMockLoggerFactory();
  let rules: Array<{ strategy: string }> = [{ strategy: 'email' }];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: Identity.name, schema: IdentitySchema },
          { name: LeaverPolicy.name, schema: LeaverPolicySchema },
        ]),
      ],
      providers: [
        IdentityCorrelationService,
        IdentityOnionService,
        IdentityDeletedMatchService,
        ReconciliationService,
        CorrelationRuleEngine,
        {
          provide: ReconciliationConfigService,
          useValue: { getConfig: async () => null, getHrSourceTags: async () => [] },
        },
        {
          provide: CorrelationConfigService,
          useValue: {
            getCorrelationConfig: async () => ({
              rules,
              conflictAction: 'review',
              confidenceThreshold: 0.7,
            }),
            getPrimaryHrSourceName: async () => null,
            getHrPriorityConfig: async () => null,
            getHrPriorityFromBlueprint: async () => null,
            getHrConnectorsWithPriorityFromBlueprint: async () => [],
            getInstalledHrConnectorsWithPriority: async () => [],
            isHrSourceName: async (name: string) => name === HR,
          },
        },
        { provide: CorrelationHashService, useValue: { hash: (v: string) => `hash-${v}` } },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: DomainEventEmitterService, useValue: events },
      ],
    }).compile();
    correlation = moduleRef.get(IdentityCorrelationService);
    identityModel = moduleRef.get(getModelToken(Identity.name));
    policyModel = moduleRef.get(getModelToken(LeaverPolicy.name));
    // The unique tenantId + profile.email index production has
    await identityModel.syncIndexes();
  });

  afterEach(async () => {
    await identityModel.deleteMany({}, { skipTenantScope: true });
    await policyModel.deleteMany({}, { skipTenantScope: true });
    jest.clearAllMocks();
    rules = [{ strategy: 'email' }];
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  /**
   * An HR joiner, offboarded later: soft-deleted with the kill switch, baseline and targets it
   * left (an account target deprovisioned, a target that keeps no account still SYNCED).
   */
  async function deletedIdentity(extra: Partial<StandardUserDto> = {}): Promise<string> {
    const identity = await correlation.ensureIdentityFromUser(
      hrRow({ jobTitle: 'Engineer', ...extra }),
    );
    await identityModel
      .updateOne(
        { _id: identity!._id },
        {
          $set: {
            deletedAt: DELETED_AT,
            deletedBy: 'offboarding-workflow',
            'controls.isLoginDisabled': true,
            accessBaseline: { attributes: { jobTitle: 'Engineer' }, recordedAt: DELETED_AT },
            provisioning: [
              {
                targetSystem: 'entra-id',
                status: 'DEPROVISIONED',
                writebackComplete: true,
                provisionedAt: null,
                lastSync: DELETED_AT,
              },
              {
                targetSystem: 'file-outbound',
                status: 'SYNCED',
                writebackComplete: true,
                provisionedAt: new Date('2020-01-02'),
                lastSync: new Date('2020-01-02'),
              },
            ],
          },
        },
      )
      .exec();
    jest.clearAllMocks();
    return String(identity!._id);
  }

  const all = () => identityModel.find({}).lean().exec();

  async function expectUnchanged(id: string) {
    const docs = await all();
    expect(docs).toHaveLength(1);
    expect(String(docs[0]._id)).toBe(id);
    expect(docs[0].deletedAt).toEqual(DELETED_AT);
    expect(docs[0].profile.jobTitle).toBe('Engineer');
    expect(events.emit).not.toHaveBeenCalled();
  }

  it.each([
    ['a terminated HR status', { customAttributes: { hrStatus: 'Terminated' } }],
    ['an end date that has passed', { endDate: new Date('2026-05-31') }],
    ['a TERMINATED status', { status: UserStatus.TERMINATED }],
  ])(
    'changes nothing for a row with %s',
    async (_label, extra) =>
      await withTestTenant(async () => {
        const id = await deletedIdentity();

        await expect(
          correlation.ensureIdentityFromUser(hrRow({ jobTitle: 'Changed', ...extra })),
        ).rejects.toMatchObject({ identityId: id, row: 'ended' });

        await expectUnchanged(id);
        expect(logger.warn).not.toHaveBeenCalled();
      }),
  );

  it("reads the tenant's own terminated status words", async () =>
    await withTestTenant(async () => {
      const id = await deletedIdentity();
      await policyModel.create({
        tenantId: TEST_TENANT_ID,
        signals: { terminated: true, endDate: true, missingFromSource: true },
        terminatedStatuses: ['Ausgeschieden'],
        missingSyncThreshold: 3,
        massLeaverMaxCount: 10,
        massLeaverMaxPercent: 5,
        timezone: 'UTC',
      });

      await expect(
        correlation.ensureIdentityFromUser(
          hrRow({ customAttributes: { hrStatus: 'ausgeschieden' } }),
        ),
      ).rejects.toMatchObject({ row: 'ended' });
      await expectUnchanged(id);
    }));

  it('changes nothing for an active row that started before the deletion, and logs it masked', async () =>
    await withTestTenant(async () => {
      const id = await deletedIdentity();

      const result = correlation.ensureIdentityFromUser(hrRow({ jobTitle: 'Changed' }));

      await expect(result).rejects.toBeInstanceOf(DeletedIdentityRowIgnored);
      await expect(result).rejects.toMatchObject({ identityId: id, row: 'not-rehire' });
      await expectUnchanged(id);
      const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain(id);
      expect(warned).toContain('a•••@corp.example');
      expect(warned).not.toContain(EMAIL);
    }));

  it('revives the identity for an active row that starts after the deletion (a rehire)', async () =>
    await withTestTenant(async () => {
      const id = await deletedIdentity();

      const revived = await correlation.ensureIdentityFromUser(
        hrRow({ startDate: new Date('2026-09-01'), jobTitle: 'Lead' }),
      );

      expect(String(revived!._id)).toBe(id);
      const docs = await all();
      expect(docs).toHaveLength(1);
      expect(docs[0].deletedAt).toBeUndefined();
      expect(docs[0].deletedBy).toBeUndefined();
      expect(docs[0].controls.isLoginDisabled).toBe(false);
      expect(docs[0].accessBaseline).toBeUndefined();
      expect(docs[0].profile.status).toBe(UserStatus.ACTIVE);
      expect(docs[0].profile.jobTitle).toBe('Lead');
      // Marked as a rehire by this source, for HR joiner detection (a rehire is a joiner)
      const metadata = docs[0].metadata as { rehiredAt?: Date; rehiredFrom?: string };
      expect(metadata.rehiredFrom).toBe(HR);
      expect(metadata.rehiredAt).toBeInstanceOf(Date);
      expect(metadata.rehiredAt!.getTime()).toBeGreaterThan(DELETED_AT.getTime());
      // The earlier employment's targets hold nothing for the new hire: none counts as onboarded,
      // and onboarding provisions each again and writes the new account back
      expect(docs[0].provisioning).toEqual([
        expect.objectContaining({
          targetSystem: 'entra-id',
          status: 'DEPROVISIONED',
          writebackComplete: false,
          lastSync: DELETED_AT,
        }),
        expect.objectContaining({
          targetSystem: 'file-outbound',
          status: 'DEPROVISIONED',
          writebackComplete: false,
          provisionedAt: null,
        }),
      ]);
      expect(events.emit).toHaveBeenCalledWith(
        DomainEventType.IDENTITY_STATUS_CHANGED,
        id,
        expect.objectContaining({
          identityId: id,
          previousStatus: UserStatus.DELETED,
          newStatus: UserStatus.ACTIVE,
        }),
        expect.objectContaining({ tenantId: TEST_TENANT_ID }),
      );
    }));

  it('finds the deleted identity through the correlation rules when the employee id is new', async () =>
    await withTestTenant(async () => {
      const id = await deletedIdentity();

      const revived = await correlation.ensureIdentityFromUser(
        hrRow({ sourceUserId: 'E-2', startDate: new Date('2026-09-01') }),
      );

      expect(String(revived!._id)).toBe(id);
      const docs = await all();
      expect(docs).toHaveLength(1);
      expect(docs[0].sources.find((s) => s.sourceName === HR)?.externalId).toBe('E-2');
    }));

  it('keeps updating a live identity that holds the same source record', async () =>
    await withTestTenant(async () => {
      await deletedIdentity();
      // A live duplicate minted before this fix (it has its own email; the index forbids sharing)
      const live = await identityModel.create({
        tenantId: TEST_TENANT_ID,
        profile: { firstName: 'Ada', lastName: 'L', email: 'ada2@corp.example', status: 'ACTIVE' },
        sources: [{ sourceName: HR, externalId: 'E-1', rawData: {}, sourceRole: 'primary-hr' }],
      });

      const updated = await correlation.ensureIdentityFromUser(
        hrRow({ email: 'ada2@corp.example', jobTitle: 'Lead' }),
      );

      expect(String(updated!._id)).toBe(String(live._id));
      expect((await identityModel.findById(live._id).lean())!.profile.jobTitle).toBe('Lead');
    }));

  /**
   * The email is unique among live identities only (a partial index), so a new hire can take the
   * address of a former employee. A record whose email only a deleted identity had was minted
   * and failed on the unique email index at every sync.
   */
  describe('an email that only a deleted identity has', () => {
    const newHire = hrRow({
      sourceUserId: 'E-2',
      employeeNumber: 'E-2',
      // Another Ada: a name in common, so the email match alone passes the name check
      lastName: 'Byron',
      startDate: new Date('2026-09-01'),
    });
    const live = async () => (await all()).filter((doc) => !doc.deletedAt);

    it('goes to a new hire, whose next sync updates that identity', async () =>
      await withTestTenant(async () => {
        rules = [{ strategy: 'employeeNumber' }];
        const formerId = await deletedIdentity({ employeeNumber: 'E-1' });

        const hired = await correlation.ensureIdentityFromUser({ ...newHire });
        await correlation.ensureIdentityFromUser({ ...newHire, jobTitle: 'Analyst' });

        expect(String(hired!._id)).not.toBe(formerId);
        expect(await live()).toEqual([
          expect.objectContaining({
            _id: hired!._id,
            profile: expect.objectContaining({ email: EMAIL, jobTitle: 'Analyst' }),
          }),
        ]);
        const former = await identityModel.findById(formerId).lean().exec();
        expect(former!.deletedAt).toEqual(DELETED_AT);
      }));

    it.each([
      [
        'a correlation rule matches the email',
        [{ strategy: 'employeeNumber' }, { strategy: 'email' }],
        {},
      ],
      ['the email is the HR record key', [{ strategy: 'employeeNumber' }], { sourceUserId: EMAIL }],
    ])(
      'does not revive the deleted identity for another person when %s',
      async (_label, ruleSet, key) =>
        await withTestTenant(async () => {
          rules = ruleSet;
          const formerId = await deletedIdentity({ employeeNumber: 'E-1', ...key });

          const hired = await correlation.ensureIdentityFromUser({ ...newHire, ...key });

          expect(String(hired!._id)).not.toBe(formerId);
          expect((await live()).map((doc) => doc.profile.lastName)).toEqual(['Byron']);
          const former = await identityModel.findById(formerId).lean().exec();
          expect(former!.deletedAt).toEqual(DELETED_AT);
          expect(former!.profile.lastName).toBe('Lovelace');
        }),
    );

    it('revives a former employee who comes back with the same employee number', async () =>
      await withTestTenant(async () => {
        rules = [{ strategy: 'employeeNumber' }, { strategy: 'email' }];
        const formerId = await deletedIdentity({ employeeNumber: 'E-1' });
        const hired = await correlation.ensureIdentityFromUser({ ...newHire });

        // A new HR id and a new address: the old one went to the new hire
        const back = await correlation.ensureIdentityFromUser(
          hrRow({
            sourceUserId: 'E-1b',
            employeeNumber: 'E-1',
            email: 'ada.lovelace@corp.example',
            startDate: new Date('2026-10-01'),
          }),
        );

        expect(String(back!._id)).toBe(formerId);
        const people = await live();
        expect(people).toHaveLength(2);
        expect(people.find((doc) => String(doc._id) === formerId)!.profile.email).toBe(
          'ada.lovelace@corp.example',
        );
        expect(people.find((doc) => String(doc._id) === String(hired!._id))!.profile.email).toBe(
          EMAIL,
        );
      }));

    // Reviving gave the rehire the address the new hire has, which failed on the unique email
    // index at every sync: the row was an error in each run until HR sent a new address
    it("holds a rehire whose address a new hire has now on the new hire's conflict, every sync", async () =>
      await withTestTenant(async () => {
        rules = [{ strategy: 'employeeNumber' }];
        const formerId = await deletedIdentity({ employeeNumber: 'E-1' });
        const hiredId = String((await correlation.ensureIdentityFromUser({ ...newHire }))!._id);
        // The former employee comes back under the old HR id, still with the old address
        const rehire = hrRow({ employeeNumber: 'E-1', startDate: new Date('2026-10-01') });

        // Each sync holds it again, with no duplicate key error
        for (let sync = 1; sync <= 2; sync++) {
          const held = correlation.ensureIdentityFromUser({ ...rehire });
          await expect(held).rejects.toBeInstanceOf(RowHeldForConflictReview);
          await expect(held).rejects.toMatchObject({ identityId: hiredId });
        }

        // Not revived: still deleted, as offboarding left it
        const former = await identityModel.findById(formerId).lean().exec();
        expect(former!.deletedAt).toEqual(DELETED_AT);
        expect(former!.profile.lastName).toBe('Lovelace');
        expect(former!.metadata?.rehiredAt).toBeUndefined();
        // The new hire keeps the address and carries the record for an admin to resolve
        const people = await live();
        expect(people.map((doc) => String(doc._id))).toEqual([hiredId]);
        expect(people[0].profile).toMatchObject({ lastName: 'Byron', email: EMAIL });
        expect(people[0].metadata).toMatchObject({
          correlationConflict: true,
          requiresReview: true,
          conflictDetails: {
            matchedBy: 'email',
            confidence: 0,
            incomingSnapshot: { sourceName: HR, lastName: 'Lovelace', email: EMAIL },
            incomingSource: { sourceName: HR, externalId: 'E-1' },
          },
        });
        expect(events.emit).toHaveBeenCalledWith(
          DomainEventType.CORRELATION_CONFLICT,
          hiredId,
          expect.objectContaining({ matchedBy: 'email', confidence: 0 }),
          expect.objectContaining({ tenantId: TEST_TENANT_ID }),
        );
        expect(events.emit).not.toHaveBeenCalledWith(
          DomainEventType.IDENTITY_STATUS_CHANGED,
          formerId,
          expect.anything(),
          expect.anything(),
        );
      }));
  });
});
