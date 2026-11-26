/**
 * Consent grants on in-memory MongoDB (tenant plugin): one record per tenant, identity and
 * purpose. Granting a purpose again makes the record that grant: its method and expiry replace
 * the old ones (and are removed when the new grant has none), and a revocation is cleared. Before,
 * Mongoose dropped the undefined values the service set, so a granted record kept the old expiry,
 * method and revocation date (the GDPR page's "Grant again" showed them). A grant needs an
 * identity of the caller's tenant (an offboarded one counts): another id is 404, nothing stored.
 */
import { NotFoundException } from '@nestjs/common';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import { Consent, ConsentDocument, ConsentSchema } from './schemas/consent.schema';
import { Identity, IdentityDocument, IdentitySchema } from '../identity/schemas/identity.schema';
import { ConsentService } from './consent.service';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const ADA = '64b7f0c2a1b2c3d4e5f60a01';
/** An offboarded identity of tenant A (soft-deleted). */
const LEFT = '64b7f0c2a1b2c3d4e5f60a02';
/** Tenant B's identity. */
const BEA = '64b7f0c2a1b2c3d4e5f60a03';
const OPERATOR = 'operator@tenant-a.example';
const DPO = 'dpo@tenant-a.example';

describe('ConsentService grants (in-memory MongoDB)', () => {
  let model: Model<ConsentDocument>;
  let identities: Model<IdentityDocument>;
  let service: ConsentService;
  const inTenant = <T>(fn: () => Promise<T>) => withTenantContext(A, fn) as Promise<T>;
  const stored = () =>
    inTenant(() => model.findOne({ identityId: ADA, purpose: 'marketing' }).lean().exec());

  beforeAll(async () => {
    await connectTestDb();
    model = mongoose.model(Consent.name, ConsentSchema) as unknown as Model<ConsentDocument>;
    identities = mongoose.model(
      Identity.name,
      IdentitySchema,
    ) as unknown as Model<IdentityDocument>;
    service = new ConsentService(model, identities);
  });

  const person = (tenantId: string, _id: string, email: string, extra = {}) =>
    withTenantContext(tenantId, () =>
      identities.create({
        _id,
        tenantId,
        profile: { firstName: 'Test', lastName: 'Person', email },
        ...extra,
      }),
    );

  beforeEach(async () => {
    await person(A, ADA, 'ada@tenant-a.example');
    await person(A, LEFT, 'left@tenant-a.example', { deletedAt: new Date('2026-10-01') });
    await person(B, BEA, 'bea@tenant-b.example');
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('a grant again after a revoke clears the revocation and keeps no old expiry or method', async () => {
    await inTenant(() =>
      service.grantConsent(
        ADA,
        { purpose: 'marketing', method: 'email', expiresAt: '2026-01-31T00:00:00.000Z' },
        OPERATOR,
      ),
    );
    await inTenant(() => service.revokeConsent(ADA, 'marketing'));
    expect(await stored()).toMatchObject({ status: 'revoked', revokedAt: expect.any(Date) });

    const regranted = await inTenant(() =>
      service.grantConsent(ADA, { purpose: 'marketing' }, DPO),
    );

    expect(regranted.toObject()).toMatchObject({ status: 'granted', grantedBy: DPO });
    const doc = await stored();
    expect(doc).toMatchObject({ status: 'granted', grantedBy: DPO, grantedAt: expect.any(Date) });
    expect(doc).not.toHaveProperty('revokedAt');
    expect(doc).not.toHaveProperty('expiresAt');
    expect(doc).not.toHaveProperty('method');
    expect(await inTenant(() => model.countDocuments({ identityId: ADA }).exec())).toBe(1);
  });

  it('a grant again with a method and an expiry replaces the old ones', async () => {
    await inTenant(() =>
      service.grantConsent(
        ADA,
        { purpose: 'marketing', method: 'email', expiresAt: '2026-01-31T00:00:00.000Z' },
        OPERATOR,
      ),
    );

    await inTenant(() =>
      service.grantConsent(
        ADA,
        { purpose: 'marketing', method: 'contract', expiresAt: '2027-06-30T21:59:59.999Z' },
        DPO,
      ),
    );

    expect(await stored()).toMatchObject({
      status: 'granted',
      grantedBy: DPO,
      method: 'contract',
      expiresAt: new Date('2027-06-30T21:59:59.999Z'),
    });
  });

  it('a first grant without a method or an expiry stores neither, in the caller tenant', async () => {
    await inTenant(() => service.grantConsent(ADA, { purpose: 'marketing' }, OPERATOR));

    const doc = await stored();
    expect(doc).toMatchObject({
      tenantId: A,
      identityId: ADA,
      purpose: 'marketing',
      status: 'granted',
      grantedBy: OPERATOR,
    });
    expect(doc).not.toHaveProperty('method');
    expect(doc).not.toHaveProperty('expiresAt');
    expect(doc).not.toHaveProperty('revokedAt');
  });

  it('answers 404 for an id that is no identity of the tenant, and stores nothing', async () => {
    const missing = '64b7f0c2a1b2c3d4e5f60a09';
    for (const id of [missing, BEA]) {
      await expect(
        inTenant(() => service.grantConsent(id, { purpose: 'marketing' }, OPERATOR)),
      ).rejects.toThrow(new NotFoundException(`Identity ${id} not found`));
    }
    const records = await model.countDocuments({}).setOptions({ skipTenantScope: true }).exec();
    expect(records).toBe(0);
  });

  it('records consent for an offboarded identity of the tenant', async () => {
    await inTenant(() => service.grantConsent(LEFT, { purpose: 'marketing' }, OPERATOR));

    expect(await inTenant(() => model.findOne({ identityId: LEFT }).lean().exec())).toMatchObject({
      status: 'granted',
      tenantId: A,
    });
  });

  // Hunt 06 F5: the { tenantId, identityId, purpose } index was not unique, so two grants at once
  // upserted two records; a revoke then changed one and the other stayed granted.
  it('keeps one record per purpose when grants run at once, so a revoke revokes it', async () => {
    await model.init();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        inTenant(() => service.grantConsent(ADA, { purpose: 'marketing' }, OPERATOR)),
      ),
    );
    await inTenant(() => service.revokeConsent(ADA, 'marketing'));

    const records = await inTenant(() => model.find({ identityId: ADA }).lean().exec());
    expect(records.map((r) => r.status)).toEqual(['revoked']);
    await expect(
      inTenant(() =>
        model.collection.insertOne({
          tenantId: A,
          identityId: ADA,
          purpose: 'marketing',
          status: 'granted',
          grantedBy: OPERATOR,
        }),
      ),
    ).rejects.toMatchObject({ code: 11000 });
  });

  // Hunt 06 F5: nothing ever wrote `expired`, so a consent past its expiresAt was listed and
  // counted as granted.
  it('lists and counts a consent past its expiry as expired', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    await inTenant(() =>
      service.grantConsent(ADA, { purpose: 'marketing', expiresAt: yesterday }, OPERATOR),
    );
    await inTenant(() =>
      service.grantConsent(ADA, { purpose: 'analytics', expiresAt: nextYear }, OPERATOR),
    );

    const listed = await inTenant(() => service.listConsents(ADA));
    expect(listed.map((c) => [c.purpose, c.status])).toEqual([
      ['analytics', 'granted'],
      ['marketing', 'expired'],
    ]);
    const report = await inTenant(() => service.getConsentReport());
    expect(report.byPurpose).toEqual(
      expect.arrayContaining([
        { purpose: 'marketing', granted: 0, revoked: 0, expired: 1 },
        { purpose: 'analytics', granted: 1, revoked: 0, expired: 0 },
      ]),
    );
  });
});
