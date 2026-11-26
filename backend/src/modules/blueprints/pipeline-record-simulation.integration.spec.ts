/**
 * PipelineService.recordSimulation on in-memory MongoDB: what a dry-run impact analysis
 * (POST /blueprints/impact-analysis) does to the tenant's pipeline status.
 *
 * It set SIMULATED whatever the status was. A DEPLOYED pipeline then refused HR joiners and joiner
 * batch approvals until someone redeployed, and the circuit breaker stopped watching it; a
 * pipeline the circuit breaker had PAUSED resumed provisioning in the onboarding and mover
 * workflows, whose guard skipped only PAUSED and STOPPED.
 *
 * Now a simulation always records when it ran and its risk, and moves the status to SIMULATED only
 * from DRAFT, SIMULATED or STOPPED. STOPPED to SIMULATED is the way back to Deploy: deploy() tells
 * a stopped pipeline to re-run the impact analysis first.
 */
import mongoose, { Connection, Model } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { PipelineService } from './pipeline.service';
import { CanvasBlueprint, CanvasBlueprintSchema, PipelineStatus } from './schemas/blueprint.schema';

type Ctor = ConstructorParameters<typeof PipelineService>;

describe('PipelineService.recordSimulation (MongoDB)', () => {
  let connection: Connection;
  let canvasModel: Model<CanvasBlueprint>;
  let service: PipelineService;

  beforeAll(async () => {
    connection = await mongoose.createConnection(testDbUri()).asPromise();
    canvasModel = connection.model(
      CanvasBlueprint.name,
      CanvasBlueprintSchema,
    ) as unknown as Model<CanvasBlueprint>;
    service = new PipelineService(
      canvasModel as unknown as Ctor[0],
      {} as Ctor[1],
      {} as Ctor[2],
      {} as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
      {} as Ctor[6],
      {} as Ctor[7],
      {} as Ctor[8],
    );
  });

  afterAll(async () => {
    await connection?.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await canvasModel.collection.deleteMany({});
  });

  const PAUSED_AT = new Date('2026-11-25T08:00:00.000Z');

  /** The tenant's draft canvas with this pipeline status (none: never set). */
  async function canvasWith(tenantId: string, status?: PipelineStatus) {
    await canvasModel.collection.insertOne({
      tenantId,
      version: 'draft',
      nodes: [],
      edges: [],
      pipelineConfig: {
        ...(status ? { status } : {}),
        ...(status === PipelineStatus.PAUSED
          ? { pausedAt: PAUSED_AT, pauseReason: 'circuit_breaker' }
          : {}),
      },
    });
  }

  async function storedConfig(tenantId: string) {
    const canvas = await canvasModel.collection.findOne({ tenantId, version: 'draft' });
    return canvas?.pipelineConfig as Record<string, unknown>;
  }

  it.each([PipelineStatus.DEPLOYED, PipelineStatus.PAUSED])(
    'keeps a %s pipeline as it is and records the simulation',
    async (status) => {
      await canvasWith('tenant-a', status);

      await service.recordSimulation('tenant-a', 'high');

      const config = await storedConfig('tenant-a');
      expect(config.status).toBe(status);
      expect(config.lastSimulationRisk).toBe('high');
      expect(config.lastSimulationAt).toBeInstanceOf(Date);
    },
  );

  it('leaves the pause of a paused pipeline in place', async () => {
    await canvasWith('tenant-a', PipelineStatus.PAUSED);

    await service.recordSimulation('tenant-a', 'low');

    const config = await storedConfig('tenant-a');
    expect(config.pausedAt).toEqual(PAUSED_AT);
    expect(config.pauseReason).toBe('circuit_breaker');
  });

  it.each([PipelineStatus.DRAFT, PipelineStatus.SIMULATED, PipelineStatus.STOPPED, undefined])(
    'moves a pipeline in %s to SIMULATED',
    async (status) => {
      await canvasWith('tenant-a', status);

      await service.recordSimulation('tenant-a', 'medium');

      const config = await storedConfig('tenant-a');
      expect(config.status).toBe(PipelineStatus.SIMULATED);
      expect(config.lastSimulationRisk).toBe('medium');
      expect(config.lastSimulationAt).toBeInstanceOf(Date);
    },
  );

  it("changes only the tenant's own canvas", async () => {
    await canvasWith('tenant-a', PipelineStatus.DRAFT);
    await canvasWith('tenant-b', PipelineStatus.DRAFT);

    await service.recordSimulation('tenant-a', 'low');

    const other = await storedConfig('tenant-b');
    expect(other.status).toBe(PipelineStatus.DRAFT);
    expect(other.lastSimulationAt).toBeUndefined();
  });

  it('does nothing for a tenant without a canvas', async () => {
    await expect(service.recordSimulation('tenant-none', 'low')).resolves.toBeUndefined();
    expect(await canvasModel.collection.countDocuments({})).toBe(0);
  });
});
