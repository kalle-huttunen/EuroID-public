/**
 * A credential policy created through the API can be edited with what the API returns (in-memory
 * MongoDB, tenant plugin registered globally as at runtime). The plugin stamped `tenantId` on every
 * subdocument too, so `passwordPolicy` and `rotationPolicy` came back with a `tenantId` inside,
 * and the edit form, which sends a stored settings object back with one value changed, was
 * refused with 400 "Unrecognized key(s) in object: 'tenantId'" by the strict update schema.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { connectTestDb, clearTestDb, closeTestDb, withTestTenant, TEST_TENANT_ID } from '@testing';
import {
  CredentialPolicy,
  CredentialPolicySchema,
  type CredentialPolicyDocument,
} from './schemas/credential-policy.schema';
import {
  CreateCredentialPolicySchema,
  UpdateCredentialPolicySchema,
} from './dtos/credential-lifecycle.dto';
import { CredentialPolicyService } from './credential-policy.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

describe('Credential policy edit with what the API returns (MongoDB)', () => {
  let model: Model<CredentialPolicyDocument>;
  let service: CredentialPolicyService;

  beforeAll(async () => {
    await connectTestDb();
    model = (mongoose.models[CredentialPolicy.name] ??
      mongoose.model(
        CredentialPolicy.name,
        CredentialPolicySchema,
      )) as unknown as Model<CredentialPolicyDocument>;
    await model.syncIndexes();
    service = new CredentialPolicyService(model);
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /** POST /credential-lifecycle/policies with the body the New policy form sends. */
  const createThroughApi = () =>
    service.create(
      TEST_TENANT_ID,
      CreateCredentialPolicySchema.parse({
        name: 'Contractors',
        targetScope: { connectorTypes: ['entra-id'], employmentTypes: ['CONTRACTOR'] },
        passwordPolicy: { maxAgeDays: 60 },
        rotationPolicy: { notifyDaysBefore: 7 },
        isActive: true,
      }),
    );

  it('returns the settings objects without a tenantId; only the policy carries it', async () =>
    await withTestTenant(async () => {
      const created = await createThroughApi();

      const policy = await service.findOne(TEST_TENANT_ID, String(created._id));

      expect(policy.tenantId).toBe(TEST_TENANT_ID);
      expect(policy.passwordPolicy).toEqual({
        maxAgeDays: 60,
        minLength: 16,
        requireComplexity: true,
        preventReuse: 5,
      });
      expect(policy.rotationPolicy).toEqual({
        enabled: false,
        intervalDays: 90,
        notifyDaysBefore: 7,
        vaultStorage: false,
      });
      expect(policy.targetScope).toEqual({
        connectorTypes: ['entra-id'],
        employmentTypes: ['CONTRACTOR'],
        entitlementTiers: [],
      });
    }));

  it('accepts the edit body built from the returned settings, and saves it', async () =>
    await withTestTenant(async () => {
      const created = await createThroughApi();
      const policy = await service.findOne(TEST_TENANT_ID, String(created._id));

      // PATCH /credential-lifecycle/policies/:id as the edit form sends it
      const body = UpdateCredentialPolicySchema.safeParse({
        passwordPolicy: { ...policy.passwordPolicy, maxAgeDays: 30 },
        rotationPolicy: { ...policy.rotationPolicy, notifyDaysBefore: 10 },
      });
      expect(body.error?.issues).toBeUndefined();

      const saved = await service.update(TEST_TENANT_ID, String(created._id), body.data!);
      expect(saved.passwordPolicy?.maxAgeDays).toBe(30);
      expect(saved.passwordPolicy?.minLength).toBe(16);
      expect(saved.rotationPolicy?.notifyDaysBefore).toBe(10);
    }));

  /** PATCH /credential-lifecycle/policies/:id with the body as an API client sends it. */
  const patch = (id: unknown, body: unknown) =>
    service.update(TEST_TENANT_ID, String(id), UpdateCredentialPolicySchema.parse(body));

  // A PATCH of one setting must not switch rotation off or reset the other settings to their
  // defaults: the inventory status (EXPIRED, EXPIRING_SOON) is judged from maxAgeDays and
  // notifyDaysBefore, so a silent reset moves the compliance numbers.
  it('keeps the settings a PATCH of one nested field does not name', async () =>
    await withTestTenant(async () => {
      const created = await service.create(
        TEST_TENANT_ID,
        CreateCredentialPolicySchema.parse({
          name: 'Admins',
          targetScope: { connectorTypes: ['entra-id'], employmentTypes: ['EMPLOYEE'] },
          passwordPolicy: { maxAgeDays: 45, minLength: 14, preventReuse: 10 },
          rotationPolicy: { enabled: true, intervalDays: 30, notifyDaysBefore: 5 },
          mfaRequirement: { required: true, methods: ['fido2'], gracePeriodDays: 7 },
        }),
      );

      await patch(created._id, { rotationPolicy: { notifyDaysBefore: 3 } });
      await patch(created._id, { passwordPolicy: { minLength: 20 } });
      await patch(created._id, { mfaRequirement: { gracePeriodDays: 30 } });
      await patch(created._id, { targetScope: { connectorTypes: ['ad'] } });

      const policy = await service.findOne(TEST_TENANT_ID, String(created._id));
      expect(policy.rotationPolicy).toEqual({
        enabled: true,
        intervalDays: 30,
        notifyDaysBefore: 3,
        vaultStorage: false,
      });
      expect(policy.passwordPolicy).toEqual({
        maxAgeDays: 45,
        minLength: 20,
        requireComplexity: true,
        preventReuse: 10,
      });
      expect(policy.mfaRequirement).toEqual({
        required: true,
        methods: ['fido2'],
        gracePeriodDays: 30,
      });
      expect(policy.targetScope).toEqual({
        connectorTypes: ['ad'],
        employmentTypes: ['EMPLOYEE'],
        entitlementTiers: [],
      });
    }));

  it('gives a settings object the policy did not have the defaults a create gives it', async () =>
    await withTestTenant(async () => {
      const created = await service.create(
        TEST_TENANT_ID,
        CreateCredentialPolicySchema.parse({ name: 'Bare' }),
      );

      await patch(created._id, { passwordPolicy: { minLength: 20 } });

      const policy = await service.findOne(TEST_TENANT_ID, String(created._id));
      expect(policy.passwordPolicy).toEqual({
        maxAgeDays: 90,
        minLength: 20,
        requireComplexity: true,
        preventReuse: 5,
      });
    }));

  it('answers 404 for a nested PATCH of a policy of another tenant or none', async () =>
    await withTestTenant(async () => {
      await expect(
        patch(new mongoose.Types.ObjectId(), { rotationPolicy: { enabled: true } }),
      ).rejects.toThrow('not found');
    }));
});
