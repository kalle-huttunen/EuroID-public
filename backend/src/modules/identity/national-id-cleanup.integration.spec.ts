/**
 * National IDs stored before a tenant's Hashed National ID rule named their key (in-memory
 * MongoDB). Package F's follow-up (national-id.ts, identity.controller.ts:281-287): correlation
 * removes the rule's field from incoming records only, so values HR delivered under the key before
 * the rule was added (or its field changed), after migration 20261125000000 ran, stayed raw in
 * `profile.customAttributes`, `sources[].rawData` and the access baseline. Saving the Brain config
 * with a rule whose field is new now removes them for the tenant, with the migration's code, and
 * gives each identity the hash of its value as its correlationId.
 */
import { createHmac } from 'crypto';
import mongoose, { Model } from 'mongoose';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import type { CorrelationConfig } from '@shared/types/correlation-config';
import { Identity, IdentitySchema, type IdentityDocument } from './schemas/identity.schema';
import type { Collection } from 'mongodb';
import { cleanStoredNationalIdsAfterSave } from './national-id-cleanup';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const SECRET = 'national-id-secret-for-tests-0123456789';
const FIELD = 'henkilotunnus';
const HETU = '131085-999X';

const expectedHash = (value: string, tenantId = TENANT) =>
  createHmac('sha256', createHmac('sha256', SECRET).update(tenantId).digest())
    .update(value.toUpperCase().replace(/[- ]/g, ''))
    .digest('hex');

const config = (field?: string): CorrelationConfig => ({
  rules: field
    ? [{ strategy: 'hashedNationalId', nationalIdSourceField: field }, { strategy: 'email' }]
    : [{ strategy: 'email' }],
  conflictAction: 'review',
  confidenceThreshold: 0.7,
});

describe('National IDs stored before the rule named their key (MongoDB)', () => {
  let identityModel: Model<IdentityDocument>;
  /** As IdentityCorrelationService.cleanStoredNationalIds runs it. */
  const service = {
    afterSettingsSaved: (
      tenantId: string,
      previous: CorrelationConfig | undefined,
      saved: CorrelationConfig | undefined,
    ) =>
      cleanStoredNationalIdsAfterSave(
        identityModel.collection as unknown as Collection,
        tenantId,
        previous,
        saved,
        { log: () => undefined, warn: () => undefined },
      ),
  };
  const originalSecret = process.env.CORRELATION_HMAC_SECRET;

  beforeAll(async () => {
    await connectTestDb();
    identityModel = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<IdentityDocument>;
    await identityModel.syncIndexes();
  });

  beforeEach(() => {
    process.env.CORRELATION_HMAC_SECRET = SECRET;
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    if (originalSecret === undefined) delete process.env.CORRELATION_HMAC_SECRET;
    else process.env.CORRELATION_HMAC_SECRET = originalSecret;
    await closeTestDb();
  });

  /** An identity HR delivered with the value under FIELD, in profile, source and baseline. */
  const seed = (tenantId: string, email: string) =>
    identityModel.collection.insertOne({
      tenantId,
      profile: { email, firstName: 'Ada', lastName: 'L', customAttributes: { [FIELD]: HETU } },
      sources: [
        {
          sourceName: 'csv-hr',
          externalId: email,
          rawData: { email, customAttributes: { [FIELD]: HETU, site: 'HQ' } },
        },
      ],
      accessBaseline: { attributes: { customAttributes: { [FIELD]: HETU } } },
    });

  it('removes the values under a newly named key and sets their hash as the correlationId', async () => {
    const { insertedId } = await seed(TENANT, 'ada@corp.example');
    const other = await seed(OTHER_TENANT, 'ada@other.example');

    const result = await service.afterSettingsSaved(TENANT, config(), config(FIELD));

    const doc = await identityModel.collection.findOne({ _id: insertedId });
    expect(JSON.stringify(doc)).not.toContain('131085');
    expect(doc?.sources[0].rawData.customAttributes).toEqual({ site: 'HQ' });
    expect(doc?.profile.correlationId).toBe(expectedHash(HETU));
    expect(result).toMatchObject({ identities: 1, hashed: 1 });
    // Another tenant is not touched
    const untouched = await identityModel.collection.findOne({ _id: other.insertedId });
    expect(untouched?.profile.customAttributes).toEqual({ [FIELD]: HETU });
  });

  it('runs nothing when the saved rule names the field it named before, or there is no rule', async () => {
    const { insertedId } = await seed(TENANT, 'ada@corp.example');

    expect(await service.afterSettingsSaved(TENANT, config(FIELD), config(FIELD))).toBeNull();
    expect(await service.afterSettingsSaved(TENANT, config(FIELD), config())).toBeNull();

    const doc = await identityModel.collection.findOne({ _id: insertedId });
    expect(doc?.profile.customAttributes).toEqual({ [FIELD]: HETU });
  });

  it('removes the values without a hash on an identity whose hash another identity has', async () => {
    await identityModel.collection.insertOne({
      tenantId: TENANT,
      profile: { email: 'grace@corp.example', correlationId: expectedHash(HETU) },
      sources: [],
    });
    const { insertedId } = await seed(TENANT, 'ada@corp.example');

    await service.afterSettingsSaved(TENANT, config(), config(FIELD));

    const doc = await identityModel.collection.findOne({ _id: insertedId });
    expect(JSON.stringify(doc)).not.toContain('131085');
    expect(doc?.profile.correlationId).toBeUndefined();
  });
});
