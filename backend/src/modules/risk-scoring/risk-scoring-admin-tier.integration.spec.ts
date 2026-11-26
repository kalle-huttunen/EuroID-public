/**
 * The admin tier factor of a risk score (in-memory MongoDB). A person scores for the linked admin
 * accounts whose entry on them is ACTIVE, but an offboarded (soft-deleted) admin identity holds no
 * privileged account any more: its entry may still read ACTIVE (it was deleted before deletion ended
 * the entry), and it must not count.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { clearTestDb, closeTestDb, connectTestDb } from '@testing';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { RiskScoringService } from './risk-scoring.service';
import { IdentityRiskScore, RiskScoreSchema } from './schemas/risk-score.schema';

mongoose.plugin(tenantPlugin);

type Ctor = ConstructorParameters<typeof RiskScoringService>;
const TENANT = 'tenant-a';
const NOW = new Date('2026-11-25T12:00:00Z');

describe('RiskScoringService admin tier factor (in-memory MongoDB)', () => {
  let identities: Model<unknown>;
  let service: RiskScoringService;

  beforeAll(async () => {
    await connectTestDb();
    identities = (mongoose.models[Identity.name] ??
      mongoose.model(Identity.name, IdentitySchema)) as unknown as Model<unknown>;
    const scores = (mongoose.models[IdentityRiskScore.name] ??
      mongoose.model(IdentityRiskScore.name, RiskScoreSchema)) as unknown as Ctor[0];
    service = new RiskScoringService(
      scores,
      { countDocuments: () => ({ exec: async () => 0 }) } as unknown as Ctor[1],
      {} as Ctor[2],
      identities as unknown as Ctor[3],
      { findOne: async (id: string) => ({ _id: id }) } as unknown as Ctor[4],
      {
        evaluateForRiskScoring: async () => ({ intent: { operations: [] }, sodViolationCount: 0 }),
      } as unknown as Ctor[5],
      { query: async () => ({ total: 1 }) } as unknown as Ctor[6],
      { getPeerDeviationScore: async () => 0 } as unknown as Ctor[7],
      {
        weightEntitlement: 10,
        weightHighRisk: 20,
        weightSod: 20,
        weightAnomaly: 10,
        weightAdmin: 15,
        weightDormant: 13,
        weightPeerDeviation: 12,
        dormancyDays: 90,
        anomalyLookbackDays: 90,
      } as unknown as Ctor[8],
    );
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const person = (email: string, extra: Record<string, unknown> = {}) =>
    identities.create({
      tenantId: TENANT,
      profile: { firstName: 'Ada', lastName: 'Lovelace', email, status: 'ACTIVE' },
      sources: [],
      ...extra,
    }) as Promise<{ _id: unknown }>;

  /** A parent whose only linked admin account (TIER_0) has an ACTIVE entry. */
  async function parentWithActiveAdmin(adminDeleted: boolean) {
    const admin = await person('adm-ada.lovelace@corp.example', {
      adminTier: 'TIER_0',
      ...(adminDeleted ? { deletedAt: new Date('2026-11-20T10:00:00Z') } : {}),
    });
    const parent = await person('ada.lovelace@corp.example', {
      linkedAdminAccounts: [
        { identityId: String(admin._id), adminTier: 'TIER_0', status: 'ACTIVE' },
      ],
    });
    // The admin identity points at the parent, as PrivilegedAccessService creates it
    await identities.updateOne(
      { _id: admin._id },
      { $set: { parentIdentityId: String(parent._id) } },
    );
    return String(parent._id);
  }

  const adminTierScore = async (identityId: string) => {
    const doc = await withTenantContext(TENANT, () =>
      service.calculateForIdentity(TENANT, identityId, 1, NOW),
    );
    return doc.factors.find((f) => f.factor === 'admin_tier')?.rawValue;
  };

  it('gives 0 to a parent whose only ACTIVE linked admin identity is deleted', async () => {
    const parentId = await withTenantContext(TENANT, () => parentWithActiveAdmin(true));

    await expect(adminTierScore(parentId)).resolves.toBe(0);
  });

  // identityId is a free string in the schema: one that is no ObjectId must not fail the score
  it('skips an entry whose identityId is no ObjectId and scores the live ones', async () => {
    const parentId = await withTenantContext(TENANT, async () => {
      const admin = await person('adm1-ada.lovelace@corp.example', { adminTier: 'TIER_1' });
      const parent = await person('ada.lovelace@corp.example', {
        linkedAdminAccounts: [
          { identityId: 'not-an-object-id', adminTier: 'TIER_0', status: 'ACTIVE' },
          { identityId: String(admin._id), adminTier: 'TIER_1', status: 'ACTIVE' },
        ],
      });
      return String(parent._id);
    });

    await expect(adminTierScore(parentId)).resolves.toBe(60);
  });

  it('still scores a live ACTIVE TIER_0 linked admin account at 100', async () => {
    const parentId = await withTenantContext(TENANT, () => parentWithActiveAdmin(false));

    await expect(adminTierScore(parentId)).resolves.toBe(100);
  });
});
