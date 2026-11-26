import { PipelineService } from './pipeline.service';

type Ctor = ConstructorParameters<typeof PipelineService>;

/** A tenant that has installed no connector config (CorrelationConfigRegistry without one). */
const noInstalledConfigs = { getConnectorProvider: () => undefined };

/**
 * The Deploy modal's readiness checks name the connectors as the canvas shows them. The Design
 * studio saves a node label as `{ text, icon }`; canvases saved earlier hold the label element
 * as JSON made it (`{ props: { children: [{ type: {} }, " CSV HR"] } }`).
 */
describe('PipelineService readiness check connector names', () => {
  const run = async (nodes: unknown[]) => {
    const blueprintsService = {
      getLatestBlueprint: jest.fn().mockResolvedValue({ nodes, pipelineConfig: {} }),
      getNodeConfig: jest.fn().mockResolvedValue({ config: { filePath: '/data/hr.csv' } }),
    };
    // No stored pipeline config: these tests are about the connector names.
    const findOne = jest.fn(() => ({
      select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(null) }) }),
    }));
    const service = new PipelineService(
      { findOne } as unknown as Ctor[0],
      blueprintsService as unknown as Ctor[1],
      { findActive: jest.fn().mockResolvedValue([]) } as unknown as Ctor[2],
      {} as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
      {} as Ctor[6],
      noInstalledConfigs as unknown as Ctor[7],
      {} as Ctor[8],
    );
    const { checks } = await service.runReadinessCheck('tenant-a');
    return Object.fromEntries(checks.map((c) => [c.name, c.message]));
  };

  it('uses the text of labels saved as { text, icon }', async () => {
    const messages = await run([
      {
        id: 'csv-hr-source',
        data: {
          role: 'source',
          type: 'csv-hr',
          label: { text: 'CSV HR', icon: 'FileTextOutlined' },
        },
      },
      {
        id: 'github-target-1',
        data: { role: 'target', type: 'github', label: { text: 'GitHub', icon: 'GithubOutlined' } },
      },
    ]);

    expect(messages['HR Source']).toBe('HR source connected (CSV HR)');
    expect(messages['Target Connectors']).toBe('GitHub: healthy');
  });

  it('reads the name from labels saved as a serialised element, and plain text labels', async () => {
    const messages = await run([
      {
        id: 'csv-hr-source',
        data: {
          role: 'source',
          type: 'csv-hr',
          label: { props: { children: [{ type: {}, props: {} }, ' CSV HR'] } },
        },
      },
      {
        id: 'json-api-hr-source-1',
        data: { role: 'source', type: 'json-api-hr', label: 'JSON API HR' },
      },
      {
        id: 'github-target-1',
        data: {
          role: 'target',
          type: 'github',
          label: { props: { children: [{ type: {}, props: {} }, ' ', 'GitHub'] } },
        },
      },
    ]);

    expect(messages['HR Source']).toBe('HR source connected (CSV HR, JSON API HR)');
    expect(messages['Target Connectors']).toBe('GitHub: healthy');
  });

  it('falls back to the node id when the label has no text', async () => {
    const messages = await run([
      { id: 'csv-hr-source', data: { role: 'source', type: 'csv-hr' } },
      {
        id: 'github-target-1',
        data: { role: 'target', type: 'github', label: { props: { children: [{ type: {} }] } } },
      },
    ]);

    expect(messages['HR Source']).toBe('HR source connected (csv-hr-source)');
    expect(messages['Target Connectors']).toBe('github-target-1: healthy');
  });
});

/**
 * The status the onboarding workflow's pause guard and HR joiner detection read: the stored
 * canvas, so a Deploy, Pause or Resume counts at once (the blueprint cache is not cleared by
 * them and would answer the old status for up to 5 s).
 */
describe('PipelineService.getPipelineStatus', () => {
  const service = (stored: unknown) => {
    const exec = jest.fn().mockResolvedValue(stored);
    const findOne = jest.fn(() => ({ select: () => ({ lean: () => ({ exec }) }) }));
    const blueprintsService = {
      getLatestBlueprint: jest.fn().mockResolvedValue({ pipelineConfig: { status: 'DRAFT' } }),
    };
    const pipeline = new PipelineService(
      { findOne } as unknown as Ctor[0],
      blueprintsService as unknown as Ctor[1],
      {} as Ctor[2],
      {} as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
      {} as Ctor[6],
      noInstalledConfigs as unknown as Ctor[7],
      {} as Ctor[8],
    );
    return { pipeline, findOne, blueprintsService };
  };

  it('reads the stored canvas of the tenant, not the cached blueprint', async () => {
    const { pipeline, findOne, blueprintsService } = service({
      pipelineConfig: { status: 'DEPLOYED' },
    });

    await expect(pipeline.getPipelineStatus('tenant-a')).resolves.toBe('DEPLOYED');
    expect(findOne).toHaveBeenCalledWith({ version: 'draft', tenantId: 'tenant-a' });
    expect(blueprintsService.getLatestBlueprint).not.toHaveBeenCalled();
  });

  it('is DRAFT for a tenant without a canvas or a status', async () => {
    await expect(service(null).pipeline.getPipelineStatus('tenant-a')).resolves.toBe('DRAFT');
    await expect(
      service({ pipelineConfig: {} }).pipeline.getPipelineStatus('tenant-a'),
    ).resolves.toBe('DRAFT');
  });
});

/**
 * Deploy's readiness check and GET /blueprints/pipeline-status read the pipeline config from the
 * stored canvas. recordSimulation, deploy, pause, resume and stop write it without clearing the
 * 5 s blueprint cache, so a Deploy right after an impact analysis answered 422 "Impact analysis
 * has not been run".
 */
describe('PipelineService pipeline config readers', () => {
  const simulated = {
    pipelineConfig: {
      status: 'SIMULATED',
      lastSimulationAt: new Date('2026-11-23T10:00:00.000Z'),
      lastSimulationRisk: 'low',
    },
  };
  const service = (stored: unknown) => {
    const exec = jest.fn().mockResolvedValue(stored);
    const findOne = jest.fn(() => ({ select: () => ({ lean: () => ({ exec }) }) }));
    // The cached blueprint still holds the config from before the impact analysis.
    const blueprintsService = {
      getLatestBlueprint: jest.fn().mockResolvedValue({ nodes: [], pipelineConfig: {} }),
    };
    const pipeline = new PipelineService(
      { findOne } as unknown as Ctor[0],
      blueprintsService as unknown as Ctor[1],
      { findActive: jest.fn().mockResolvedValue([]) } as unknown as Ctor[2],
      {} as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
      {} as Ctor[6],
      noInstalledConfigs as unknown as Ctor[7],
      {} as Ctor[8],
    );
    return { pipeline, findOne };
  };

  it('passes the impact analysis check right after a simulation was recorded', async () => {
    const { checks } = await service(simulated).pipeline.runReadinessCheck('tenant-a');

    expect(checks.find((c) => c.name === 'Impact Analysis')).toEqual({
      name: 'Impact Analysis',
      status: 'pass',
      message: 'Impact analysis reviewed (low risk)',
    });
  });

  it('answers the stored pipeline config of the tenant, not the cached one', async () => {
    const { pipeline, findOne } = service(simulated);

    await expect(pipeline.getPipelineConfig('tenant-a')).resolves.toEqual(simulated.pipelineConfig);
    expect(findOne).toHaveBeenCalledWith({ version: 'draft', tenantId: 'tenant-a' });
  });

  it('answers an empty config for a tenant without a canvas', async () => {
    await expect(service(null).pipeline.getPipelineConfig('tenant-a')).resolves.toEqual({});
  });
});

/**
 * The Deploy modal's "Scheduled Sync" check always warned "No scheduled sync (manual only)",
 * whatever the HR sources said. SyncSchedulerService (hourly cron) syncs an installed connector
 * whose saved syncIntervalHours is above 0, so the check reads that config for each source of
 * the canvas: it passes when one has an interval, naming each, and warns when none has.
 */
describe('PipelineService readiness check: Scheduled Sync', () => {
  const sources = [
    { id: 'csv-hr-source', data: { role: 'source', type: 'csv-hr', label: { text: 'CSV HR' } } },
    {
      id: 'json-api-hr-source-1',
      data: { role: 'source', type: 'json-api-hr', label: { text: 'JSON API HR' } },
    },
  ];
  const scheduledSync = async (saved: Record<string, Record<string, string> | null>) => {
    const findOne = jest.fn(() => ({
      select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(null) }) }),
    }));
    const installed = {
      getConfig: jest.fn(async (name: string) => (saved[name] ? { config: saved[name] } : null)),
    };
    const service = new PipelineService(
      { findOne } as unknown as Ctor[0],
      {
        getLatestBlueprint: jest.fn().mockResolvedValue({ nodes: sources, pipelineConfig: {} }),
        getNodeConfig: jest.fn().mockResolvedValue({ config: {} }),
      } as unknown as Ctor[1],
      { findActive: jest.fn().mockResolvedValue([]) } as unknown as Ctor[2],
      {} as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
      {} as Ctor[6],
      { getConnectorProvider: () => installed } as unknown as Ctor[7],
      {} as Ctor[8],
    );
    const { checks } = await service.runReadinessCheck('tenant-a');
    return checks.find((c) => c.name === 'Scheduled Sync');
  };

  it('passes when an HR source has a sync interval, naming each source', async () => {
    await expect(
      scheduledSync({
        'csv-hr': { filePath: 'hr.csv', syncIntervalHours: '24' },
        'json-api-hr': { url: 'https://hr.example.com', syncIntervalHours: '0' },
      }),
    ).resolves.toEqual({
      name: 'Scheduled Sync',
      status: 'pass',
      message: 'CSV HR: every 24 h, JSON API HR: manual only',
    });
  });

  it('warns when no HR source has one, or a source is not installed', async () => {
    await expect(
      scheduledSync({
        'csv-hr': { filePath: 'hr.csv', syncIntervalHours: '0' },
        'json-api-hr': null,
      }),
    ).resolves.toEqual({
      name: 'Scheduled Sync',
      status: 'warn',
      message: 'No scheduled sync (manual only): set a Sync Interval on an HR source',
    });
  });
});

/**
 * After a circuit breaker trip, Resume kept the hour's provisioning metrics: the next outcome,
 * a success too, recomputed the same window's error rate (1 failure in 6 is 16.7%, over the 5%
 * default) and paused the pipeline again until the hour rolled over (hunt 05 F7).
 */
describe('PipelineService.resume', () => {
  const pausedCanvas = { _id: 'canvas-1', pipelineConfig: { status: 'PAUSED' } };
  const setup = (canvas: unknown) => {
    const canvasModel = {
      findOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(canvas) })),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const metricsModel = { deleteOne: jest.fn(() => ({ exec: jest.fn().mockResolvedValue({}) })) };
    const pipeline = new PipelineService(
      canvasModel as unknown as Ctor[0],
      {} as Ctor[1],
      {} as Ctor[2],
      {} as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
      {} as Ctor[6],
      noInstalledConfigs as unknown as Ctor[7],
      metricsModel as unknown as Ctor[8],
    );
    return { pipeline, canvasModel, metricsModel };
  };

  it("starts the circuit breaker's window afresh", async () => {
    const { pipeline, metricsModel } = setup(pausedCanvas);

    await expect(pipeline.resume('tenant-a')).resolves.toEqual({ status: 'DEPLOYED' });

    expect(metricsModel.deleteOne).toHaveBeenCalledWith({ tenantId: 'tenant-a' });
  });

  it('keeps the metrics when the pipeline is not paused', async () => {
    const { pipeline, metricsModel } = setup({
      _id: 'canvas-1',
      pipelineConfig: { status: 'DEPLOYED' },
    });

    await expect(pipeline.resume('tenant-a')).rejects.toThrow('Pipeline is not paused');
    expect(metricsModel.deleteOne).not.toHaveBeenCalled();
  });
});

/**
 * A critical-risk simulation made the "Impact Analysis" check a warning that "requires manual
 * acknowledgement", but nothing asked for one: Deploy was enabled. And a canvas saved after the
 * simulation was deployed on that old simulation (hunt 05 F12).
 */
describe('PipelineService: the impact analysis Deploy relies on', () => {
  const SIMULATED_AT = new Date('2026-11-25T10:00:00Z');
  const nodes = [
    { id: 'csv-hr-source', data: { role: 'source', type: 'csv-hr', label: { text: 'CSV HR' } } },
    { id: 'github-target-1', data: { role: 'target', type: 'github', label: { text: 'GitHub' } } },
  ];
  const setup = (pipelineConfig: Record<string, unknown>) => {
    const canvas = { _id: 'canvas-1', pipelineConfig };
    const findOne = jest.fn(() => ({
      select: () => ({
        lean: () => ({ exec: jest.fn().mockResolvedValue({ pipelineConfig }) }),
      }),
      exec: jest.fn().mockResolvedValue(canvas),
    }));
    const updateOne = jest.fn().mockResolvedValue({});
    const emit = jest.fn();
    const pipeline = new PipelineService(
      { findOne, updateOne } as unknown as Ctor[0],
      {
        getLatestBlueprint: jest.fn().mockResolvedValue({ nodes, pipelineConfig: {} }),
        getNodeConfig: jest.fn().mockResolvedValue({ config: { filePath: '/data/hr.csv' } }),
      } as unknown as Ctor[1],
      { findActive: jest.fn().mockResolvedValue([{ _id: 'p-1' }]) } as unknown as Ctor[2],
      {} as Ctor[3],
      {} as Ctor[4],
      {} as Ctor[5],
      { emit } as unknown as Ctor[6],
      noInstalledConfigs as unknown as Ctor[7],
      {} as Ctor[8],
    );
    return { pipeline, updateOne, emit };
  };
  const impactCheck = async (pipelineConfig: Record<string, unknown>) =>
    (await setup(pipelineConfig).pipeline.runReadinessCheck('tenant-a')).checks.find(
      (c) => c.name === 'Impact Analysis',
    );

  it('fails when the canvas was saved after the last impact analysis', async () => {
    const check = await impactCheck({
      status: 'SIMULATED',
      lastSimulationAt: SIMULATED_AT,
      lastSimulationRisk: 'low',
      canvasSavedAt: new Date(SIMULATED_AT.getTime() + 60_000),
    });

    expect(check).toEqual({
      name: 'Impact Analysis',
      status: 'fail',
      message: 'The canvas was saved after the last impact analysis: run it again',
    });
  });

  it('passes a simulation of the canvas as saved', async () => {
    const check = await impactCheck({
      status: 'SIMULATED',
      lastSimulationAt: SIMULATED_AT,
      lastSimulationRisk: 'low',
      canvasSavedAt: new Date(SIMULATED_AT.getTime() - 60_000),
    });

    expect(check?.status).toBe('pass');
  });

  const critical = {
    status: 'SIMULATED',
    lastSimulationAt: SIMULATED_AT,
    lastSimulationRisk: 'critical',
  };

  it('marks a critical-risk simulation as needing confirmation', async () => {
    expect(await impactCheck(critical)).toEqual({
      name: 'Impact Analysis',
      status: 'warn',
      message: 'Impact analysis reviewed (critical risk): confirm it to deploy',
      acknowledgementRequired: true,
    });
  });

  it('refuses to deploy a critical-risk simulation without confirmation (422)', async () => {
    const { pipeline, updateOne } = setup(critical);

    await expect(pipeline.deploy('tenant-a', 'ops@corp.example')).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({
        message: 'Deploying with a critical-risk impact analysis needs its confirmation',
      }),
    });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('deploys a confirmed critical-risk simulation and records the confirmation', async () => {
    const { pipeline, emit } = setup(critical);

    await expect(
      pipeline.deploy('tenant-a', 'ops@corp.example', { acknowledgeCriticalRisk: true }),
    ).resolves.toMatchObject({ status: 'DEPLOYED' });
    expect(emit).toHaveBeenCalledWith(
      'pipeline.deployed',
      'tenant-a',
      expect.objectContaining({ deployedBy: 'ops@corp.example', acknowledgedRisk: 'critical' }),
      { tenantId: 'tenant-a' },
    );
  });
});
