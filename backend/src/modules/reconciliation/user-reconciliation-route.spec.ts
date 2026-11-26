/**
 * POST /reconciliation/user/:userId takes the identity's _id. The value goes into the workflow id
 * (`t-<tenant>-user-recon-<userId>-<ms>`) and the workflow's UserNotFound message, which Temporal
 * stores in clear: the payload codec covers payloads only. The lookup behind it also matched
 * `profile.email`, so an email was accepted and ended up in the Temporal history.
 */
import { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { ConnectorHealthService } from '../connectors/connector-health.service';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';
import { DriftService } from './drift.service';
import { OrphanCleanupService } from './orphan-cleanup.service';

const IDENTITY_ID = '6650aaaaaaaaaaaaaaaaaaaa';

describe('POST /reconciliation/user/:userId', () => {
  let app: INestApplication;
  const startUserReconciliation = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReconciliationController],
      providers: [
        { provide: ReconciliationService, useValue: { startUserReconciliation } },
        { provide: DriftService, useValue: {} },
        { provide: OrphanCleanupService, useValue: {} },
        { provide: ConnectorHealthService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    startUserReconciliation.mockReset().mockResolvedValue(`t-tenant-a-user-recon-${IDENTITY_ID}-1`);
  });

  it("starts the reconciliation of the identity's _id", async () => {
    const res = await request(app.getHttpServer())
      .post(`/reconciliation/user/${IDENTITY_ID}`)
      .send({ targetSystems: ['entra-id'] });

    expect(res.status).toBe(201);
    expect(startUserReconciliation).toHaveBeenCalledWith(IDENTITY_ID, ['entra-id']);
  });

  it.each([
    ['an email', 'ada.lovelace@example.com'],
    ['a source user id', 'user-123'],
  ])('refuses %s with 400 and starts nothing', async (_label, userId) => {
    const res = await request(app.getHttpServer())
      .post(`/reconciliation/user/${encodeURIComponent(userId)}`)
      .send({ targetSystems: ['entra-id'] });

    expect(res.status).toBe(400);
    expect(startUserReconciliation).not.toHaveBeenCalled();
  });
});
