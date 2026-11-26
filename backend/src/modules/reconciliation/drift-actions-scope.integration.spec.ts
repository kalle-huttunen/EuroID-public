/**
 * Drift actions of the drift dashboard on in-memory MongoDB, run without the tenant plugin, so
 * the service's own filters are what scope them (the plugin is a second guard with tests of its
 * own in tenant.plugin.spec.ts).
 *
 * Proves: ignore and bulk ignore change only drifts of the caller's tenant; ignore and correct
 * refuse a drift that is corrected or ignored already (409), and correct then changes nothing in
 * the target; bulk ignore leaves a drift that is no longer open as it is; the dashboard counters
 * count only the caller's open drifts.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { createMockEventEmitter, closeTestDb, testDbUri } from '@testing';
import { DriftService } from './drift.service';
import { DriftCorrectionService } from './drift-correction.service';
import { OrphanCleanupService } from './orphan-cleanup.service';
import { Drift, DriftDocument, DriftSchema } from './schemas/drift.schema';

const A = 'tenant-a';
const B = 'tenant-b';

describe('DriftService drift actions, scoped by tenant and status (in-memory MongoDB)', () => {
  let moduleRef: TestingModule;
  let service: DriftService;
  let driftModel: Model<DriftDocument>;
  const correction = { executeCorrection: jest.fn() };
  const events = createMockEventEmitter();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([{ name: Drift.name, schema: DriftSchema }]),
      ],
      providers: [
        DriftService,
        { provide: DriftCorrectionService, useValue: correction },
        { provide: DomainEventEmitterService, useValue: events },
        { provide: OrphanCleanupService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(DriftService);
    driftModel = moduleRef.get(getModelToken(Drift.name));
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await driftModel.deleteMany({});
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  /** A stored drift of that tenant; open, medium and not auto-correctable unless overridden. */
  async function drift(tenantId: string, overrides: Partial<Drift> = {}): Promise<string> {
    const doc = await driftModel.create({
      tenantId,
      type: 'FIELD_MISMATCH',
      severity: 'medium',
      userId: '64b7f0c2a1b2c3d4e5f60001',
      userDisplayName: 'Ada Lovelace',
      userEmail: 'ada.lovelace@corp.example',
      targetSystem: 'entra-id',
      field: 'jobTitle',
      status: 'open',
      autoCorrectEligible: false,
      ...overrides,
    });
    return String(doc._id);
  }

  const statusOf = async (id: string) => (await driftModel.findById(id).lean())?.status;

  it("ignores a drift of the caller's tenant; another tenant's drift is not found and stays open", async () => {
    const own = await drift(A);
    const foreign = await drift(B);

    await expect(withTenantContext(A, () => service.ignoreDrift(foreign))).rejects.toThrow(
      NotFoundException,
    );
    await withTenantContext(A, () => service.ignoreDrift(own));

    expect(await statusOf(foreign)).toBe('open');
    expect(await statusOf(own)).toBe('ignored');
  });

  // Relabelled ignored, a corrected drift that comes back with the same values was never recorded
  it.each(['corrected', 'ignored'] as const)(
    'refuses to ignore a %s drift (409) and leaves it as it is',
    async (status) => {
      const id = await drift(A, { status });
      const ignore = () => withTenantContext(A, () => service.ignoreDrift(id));

      await expect(ignore()).rejects.toThrow(ConflictException);
      await expect(ignore()).rejects.toThrow(
        `Drift ${id} is ${status}: only an open drift, or a quarantined orphan drift, can be ignored`,
      );
      expect(await statusOf(id)).toBe(status);
    },
  );

  // It wrote the drift's stored, possibly stale value to the target again, and relabelled an
  // ignored drift corrected
  it.each(['corrected', 'ignored'] as const)(
    'refuses to correct a drift that is %s (409): nothing is written to the target or emitted',
    async (status) => {
      const id = await drift(A, { status });
      const correct = () => withTenantContext(A, () => service.autoCorrect(id));

      await expect(correct()).rejects.toThrow(ConflictException);
      await expect(correct()).rejects.toThrow(
        `Drift ${id} is ${status}: only an open drift, or a quarantined orphan drift, can be corrected`,
      );
      expect(correction.executeCorrection).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(await statusOf(id)).toBe(status);
    },
  );

  it("bulk ignores only the caller's open drifts: another tenant's and a corrected one stay", async () => {
    const open = await drift(A);
    const corrected = await drift(A, { status: 'corrected', correctedAt: new Date() });
    const foreign = await drift(B);

    const ignored = await withTenantContext(A, () =>
      service.bulkIgnore([open, corrected, foreign]),
    );

    expect(ignored).toBe(1);
    expect(await statusOf(open)).toBe('ignored');
    expect(await statusOf(corrected)).toBe('corrected');
    expect(await statusOf(foreign)).toBe('open');
  });

  it("counts the caller's open drifts: total, critical, auto-fix eligible and pending", async () => {
    await drift(A, { severity: 'critical', autoCorrectEligible: true });
    await drift(A, { severity: 'critical', autoCorrectEligible: false });
    await drift(A, { severity: 'high', autoCorrectEligible: true });
    await drift(A, { severity: 'medium', autoCorrectEligible: true });
    // Neither counts: a drift that is no longer open, and another tenant's
    await drift(A, { severity: 'critical', status: 'corrected', autoCorrectEligible: true });
    await drift(B, { severity: 'critical', autoCorrectEligible: false });

    const stats = await withTenantContext(A, () => service.getStats());

    expect(stats).toEqual({ total: 4, critical: 2, autoFixEligible: 3, pending: 1 });
  });
});
