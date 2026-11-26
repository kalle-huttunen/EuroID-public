/**
 * The Deploy modal's circuit breaker save: PATCH /blueprints/pipeline-config with the body pinned
 * in test/fixtures/blueprint-pipeline-config.payload.json (DeployModal.test.tsx checks the modal
 * sends exactly that body). The route used to be declared after PATCH /blueprints/:id, which
 * answered every save with "400 Invalid ID format: pipeline-config".
 */
import { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as request from 'supertest';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { authConfig } from '@infrastructure/config/auth.config';
import { BlueprintsController } from './blueprints.controller';
import { BlueprintsService } from './blueprints.service';
import { ImpactAnalysisService } from './impact-analysis.service';
import { PipelineService } from './pipeline.service';
import { IdentityService } from '../identity/identity.service';
import { EntraService } from '../connectors/entra-connector/entra.service';

type PipelineCtor = ConstructorParameters<typeof PipelineService>;

/** A tenant that has installed no connector config (CorrelationConfigRegistry without one). */
const noInstalledConfigs = { getConnectorProvider: () => undefined };

const FIXTURE = resolve(__dirname, '../../../test/fixtures/blueprint-pipeline-config.payload.json');
const deployModalBody = (): Record<string, unknown> => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const CANVAS_ID = '6740a1b2c3d4e5f6a7b8c9d0';

describe('PATCH /blueprints/pipeline-config (Deploy modal circuit breaker save)', () => {
  let app: INestApplication;
  const canvasModel = {
    findOne: jest.fn(),
    updateOne: jest.fn(),
  };
  const blueprintsService = {
    updateNodeConfig: jest.fn(),
    toMaskedNode: jest.fn((node: unknown) => node),
  };

  beforeAll(async () => {
    const pipelineService = new PipelineService(
      canvasModel as unknown as PipelineCtor[0],
      blueprintsService as unknown as PipelineCtor[1],
      {} as PipelineCtor[2],
      {} as PipelineCtor[3],
      {} as PipelineCtor[4],
      {} as PipelineCtor[5],
      {} as PipelineCtor[6],
      noInstalledConfigs as unknown as PipelineCtor[7],
      {} as PipelineCtor[8],
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [BlueprintsController],
      providers: [
        { provide: BlueprintsService, useValue: blueprintsService },
        { provide: ImpactAnalysisService, useValue: {} },
        { provide: PipelineService, useValue: pipelineService },
        { provide: IdentityService, useValue: {} },
        { provide: EntraService, useValue: {} },
        { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: 'tenant-a' } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    canvasModel.findOne.mockReturnValue({ exec: async () => ({ _id: CANVAS_ID }) });
    canvasModel.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  const patch = (path: string, body: object) => request(app.getHttpServer()).patch(path).send(body);

  it("stores the threshold the Deploy modal sends in the tenant's draft canvas", async () => {
    const res = await patch('/blueprints/pipeline-config', deployModalBody());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(canvasModel.findOne).toHaveBeenCalledWith({ version: 'draft', tenantId: 'tenant-a' });
    expect(canvasModel.updateOne).toHaveBeenCalledWith(
      { _id: CANVAS_ID },
      { $set: { 'pipelineConfig.errorThresholdPercent': 10 } },
    );
    expect(blueprintsService.updateNodeConfig).not.toHaveBeenCalled();
  });

  it('answers an out-of-range threshold with 400 naming the field, and stores nothing', async () => {
    const res = await patch('/blueprints/pipeline-config', { errorThresholdPercent: 0 });

    expect(res.status).toBe(400);
    expect(res.body.message).toEqual([expect.stringMatching(/^errorThresholdPercent: /)]);
    expect(canvasModel.updateOne).not.toHaveBeenCalled();
  });

  it('still routes PATCH /blueprints/:id to the node config update', async () => {
    blueprintsService.updateNodeConfig.mockResolvedValue({ nodeId: 'okta-target' });

    const res = await patch(`/blueprints/${CANVAS_ID}`, { config: { orgUrl: 'https://x' } });

    expect(res.status).toBe(200);
    expect(blueprintsService.updateNodeConfig).toHaveBeenCalledWith(CANVAS_ID, {
      config: { orgUrl: 'https://x' },
    });
    expect(canvasModel.updateOne).not.toHaveBeenCalled();
  });
});
