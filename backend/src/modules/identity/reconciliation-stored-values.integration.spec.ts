/**
 * Reconcile over source records whose stored values the profile's enum fields cannot take
 * (in-memory MongoDB, the real ReconciliationService and identity schema). Link on an
 * uncorrelated twin answered 500: reconcile copied `sources.rawData.status` "active" (the demo
 * seed's lower case) into the profile, and the save failed with "profile.status: 'active' is not
 * a valid enum value" (browser check 2026-11-25). HR ingest validates the row (StandardUserSchema),
 * so it stores only enum values; a record stored another way must still not turn into a 500.
 */
import mongoose, { Model } from 'mongoose';
import { Logger } from '@nestjs/common';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { EmploymentType, UserPriority, UserStatus } from '@shared/dtos/standard-user.dto';
import { connectTestDb, clearTestDb, closeTestDb, withTestTenant, TEST_TENANT_ID } from '@testing';
import { Identity, IdentitySchema, type IdentityDocument } from './schemas/identity.schema';
import { ReconciliationService } from './reconciliation.service';
import type { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import type { ReconciliationConfigService } from './reconciliation-config.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

describe('Reconcile over stored source values (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  let service: ReconciliationService;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    await connectTestDb();
    identityModel = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<IdentityDocument>;
    service = new ReconciliationService(
      identityModel,
      {
        getCorrelationConfig: jest.fn().mockResolvedValue({}),
        getHrConnectorsWithPriorityFromBlueprint: jest.fn().mockResolvedValue([]),
        getInstalledHrConnectorsWithPriority: jest.fn().mockResolvedValue([]),
      } as unknown as CorrelationConfigService,
      { getConfig: jest.fn().mockResolvedValue(null) } as unknown as ReconciliationConfigService,
    );
  });

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /** An identity whose one HR record holds `raw` (written as it was stored, without the schema). */
  async function identityWithRecord(raw: Record<string, unknown>) {
    const { insertedId } = await identityModel.collection.insertOne({
      tenantId: TEST_TENANT_ID,
      profile: {
        firstName: 'Lukas',
        lastName: 'Neumann',
        email: 'lukas.neumann@corp.example',
        status: UserStatus.SUSPENDED,
        employmentType: EmploymentType.CONTRACTOR,
        priority: UserPriority.STANDARD,
      },
      sources: [
        {
          sourceName: 'json-api-hr',
          externalId: 'E-200',
          sourceRole: 'primary-hr',
          contractType: 'primary',
          lastSync: new Date('2026-11-20T08:00:00Z'),
          rawData: {
            firstName: 'Lukas',
            lastName: 'Neumann',
            email: 'lukas.neumann@corp.example',
            ...raw,
          },
        },
      ],
      metadata: { version: 1 },
      provisioning: [],
      controls: {},
    });
    return (await identityModel.findById(insertedId).exec())!;
  }

  it('takes a status or employment type written in another case as the value it names', async () =>
    await withTestTenant(async () => {
      const identity = await identityWithRecord({
        status: 'active',
        employmentType: 'full time',
        priority: 'vip',
      });

      await service.reconcile(identity);

      const stored = await identityModel.findById(identity._id).lean().exec();
      expect(stored!.profile.status).toBe(UserStatus.ACTIVE);
      expect(stored!.profile.employmentType).toBe(EmploymentType.FULL_TIME);
      expect(stored!.profile.priority).toBe(UserPriority.VIP);
    }));

  it('leaves out a value that names none, keeps the profile value and logs it', async () =>
    await withTestTenant(async () => {
      const identity = await identityWithRecord({
        status: 'left',
        employmentType: 'Freelance',
        jobTitle: 'Analyst',
      });

      await service.reconcile(identity);

      const stored = await identityModel.findById(identity._id).lean().exec();
      expect(stored!.profile.status).toBe(UserStatus.SUSPENDED);
      expect(stored!.profile.employmentType).toBe(EmploymentType.CONTRACTOR);
      expect(stored!.profile.jobTitle).toBe('Analyst'); // the rest of the record still applies
      const logged = warn.mock.calls.map(([message]) => String(message)).join('\n');
      expect(logged).toMatch(/json-api-hr.*status "left"/);
      expect(logged).toMatch(/json-api-hr.*employmentType "Freelance"/);
    }));
});
