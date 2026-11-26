/**
 * GET /risk-scores/:identityId on in-memory MongoDB with the tenant plugin: the service asks by
 * identity id and the plugin adds the request's tenant, so another tenant's score of the same
 * identity id is never answered.
 */
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { closeTestDb, connectTestDb } from '@testing';
import { RiskScoringService } from './risk-scoring.service';
import { IdentityRiskScore, RiskScoreSchema } from './schemas/risk-score.schema';

mongoose.plugin(tenantPlugin);

type Ctor = ConstructorParameters<typeof RiskScoringService>;

describe('RiskScoringService.getForIdentity (in-memory MongoDB)', () => {
  let scores: Model<unknown>;
  let service: RiskScoringService;

  const score = (tenantId: string, value: number) => ({
    tenantId,
    identityId: 'id-1',
    score: value,
    trend: 'STABLE',
    calculatedAt: new Date(),
  });

  beforeAll(async () => {
    await connectTestDb();
    scores = mongoose.model(IdentityRiskScore.name, RiskScoreSchema) as unknown as Model<unknown>;
    // getForIdentity reads the score model only
    const unused = undefined as never;
    service = new RiskScoringService(
      scores as unknown as Ctor[0],
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
    );
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("should return risk score when found: the request tenant's, not another tenant's", async () => {
    // Stored first, so a query without the tenant would find it
    await withTenantContext('tenant-b', () => scores.create(score('tenant-b', 70)));
    await withTenantContext('tenant-a', () => scores.create(score('tenant-a', 45)));

    await expect(
      withTenantContext('tenant-a', () => service.getForIdentity('id-1')),
    ).resolves.toMatchObject({ tenantId: 'tenant-a', identityId: 'id-1', score: 45 });
    await expect(
      withTenantContext('tenant-c', () => service.getForIdentity('id-1')),
    ).resolves.toBeNull();
  });
});

/**
 * The nightly risk_scores.calculated event's avgScore is the tenant's average score. It was the
 * mean of the ten riskiest identities, which overstates the tenant's risk for any consumer that
 * reads it as an average (webhooks, the audit log).
 */
describe('RiskScoringService.getAverageScore (in-memory MongoDB)', () => {
  let scores: Model<unknown>;
  let service: RiskScoringService;

  beforeAll(async () => {
    await connectTestDb();
    scores = mongoose.model(IdentityRiskScore.name, RiskScoreSchema) as unknown as Model<unknown>;
    const unused = undefined as never;
    service = new RiskScoringService(
      scores as unknown as Ctor[0],
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
    );
    await scores.collection.deleteMany({});
    const rows = [
      ...[90, 80, 10, 20].map((value, i) => ({ tenantId: 'tenant-a', value, i })),
      { tenantId: 'tenant-b', value: 100, i: 9 },
    ];
    for (const { tenantId, value, i } of rows) {
      await withTenantContext(tenantId, () =>
        scores.create({
          tenantId,
          identityId: `avg-${i}`,
          score: value,
          trend: 'STABLE',
          calculatedAt: new Date(),
        }),
      );
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("averages every score of the tenant, not another tenant's", async () => {
    await expect(
      withTenantContext('tenant-a', () => service.getAverageScore('tenant-a')),
    ).resolves.toBe(50);
  });

  it('is undefined for a tenant without scores', async () => {
    await expect(
      withTenantContext('tenant-c', () => service.getAverageScore('tenant-c')),
    ).resolves.toBeUndefined();
  });
});
