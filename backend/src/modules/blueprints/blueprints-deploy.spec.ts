/**
 * POST /blueprints/deploy refuses a pipeline that fails its readiness check with HTTP 422 and the
 * readiness result in the body, as the controller's @ApiResponse and docs/USER_FLOWS.md 7.5
 * promise. It answered HTTP 400 with `statusCode: 422` only in the body, so an API client that
 * checks the status saw a generic bad request.
 */
import { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
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

describe('POST /blueprints/deploy', () => {
  let app: INestApplication;
  // The readiness check reads the stored pipeline config: this tenant has none.
  const canvasModel = {
    findOne: jest.fn(() => ({
      select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(null) }) }),
    })),
    updateOne: jest.fn(),
  };

  beforeAll(async () => {
    // A tenant with an empty canvas and no active policy: the readiness check fails.
    const pipelineService = new PipelineService(
      canvasModel as unknown as PipelineCtor[0],
      {
        getLatestBlueprint: jest.fn().mockResolvedValue({ nodes: [], pipelineConfig: {} }),
      } as unknown as PipelineCtor[1],
      { findActive: jest.fn().mockResolvedValue([]) } as unknown as PipelineCtor[2],
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
        { provide: BlueprintsService, useValue: {} },
        { provide: ImpactAnalysisService, useValue: {} },
        { provide: PipelineService, useValue: pipelineService },
        { provide: IdentityService, useValue: {} },
        { provide: EntraService, useValue: {} },
        { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: 'tenant-a' } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers a failed readiness check with HTTP 422 and the checks, and deploys nothing', async () => {
    const res = await request(app.getHttpServer()).post('/blueprints/deploy');

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      statusCode: 422,
      message: 'Readiness check failed',
      readiness: {
        ready: false,
        checks: expect.arrayContaining([
          { name: 'HR Source', status: 'fail', message: 'No HR source connector configured' },
          { name: 'Active Policies', status: 'fail', message: 'No active policies configured' },
        ]),
      },
    });
    // Only the readiness check read the canvas: deploy did not go on to load it.
    expect(canvasModel.findOne).toHaveBeenCalledTimes(1);
    expect(canvasModel.updateOne).not.toHaveBeenCalled();
  });

  // Hunt 05 F12: the confirmation of a critical-risk impact analysis reaches the deploy
  it('passes acknowledgeCriticalRisk to the deploy, and refuses another type with 400', async () => {
    const deploy = jest
      .spyOn(PipelineService.prototype, 'deploy')
      .mockResolvedValue({ status: 'DEPLOYED' as never, deployedAt: new Date() });
    try {
      await request(app.getHttpServer())
        .post('/blueprints/deploy')
        .send({ acknowledgeCriticalRisk: true })
        .expect(201);
      expect(deploy).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
        acknowledgeCriticalRisk: true,
      });

      await request(app.getHttpServer())
        .post('/blueprints/deploy')
        .send({ acknowledgeCriticalRisk: 'yes' })
        .expect(400);
    } finally {
      deploy.mockRestore();
    }
  });
});
