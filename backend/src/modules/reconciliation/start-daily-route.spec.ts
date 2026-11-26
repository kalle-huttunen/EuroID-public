/**
 * POST /reconciliation/start-daily takes the run's settings. notifySlack was accepted and nothing
 * read it: EuroID has no Slack sender. It is refused with 400 and a message that names the way
 * that works (a webhook subscribed to reconciliation.drift_threshold_exceeded); notifyEmail goes
 * to the email notifications (a user of the tenant).
 *
 * enabled and cronSchedule were required and nothing read them: a run starts on request, no
 * schedule exists. Both are optional, and a cronSchedule or enabled: false is refused with 400
 * rather than taken for a schedule. includedDepartments and excludedUsers are the run's scan
 * scope; an excludedUsers entry is an identity id or an email address, anything else (a name, a
 * typo) is refused, since it would exclude nobody while the caller believes it does.
 */
import { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { ConnectorHealthService } from '../connectors/connector-health.service';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';
import { DriftService } from './drift.service';
import { OrphanCleanupService } from './orphan-cleanup.service';

/** What [Run daily reconciliation] sends (ReconciliationDashboard.tsx). */
const BODY = {
  targetSystems: ['entra-id'],
  autoCorrect: true,
  autoCorrectTypes: ['MISSING_USER', 'STATUS_MISMATCH'],
  requireApprovalForDeletes: true,
  notifyOnDrift: true,
  maxDriftsBeforeAlert: 10,
  criticalDriftAlertThreshold: 5,
};

describe('POST /reconciliation/start-daily', () => {
  let app: INestApplication;
  const startDailyReconciliation = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReconciliationController],
      providers: [
        { provide: ReconciliationService, useValue: { startDailyReconciliation } },
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
    startDailyReconciliation.mockReset().mockResolvedValue('t-default-daily-recon');
  });

  it('starts the run with the settings, notifyEmail included', async () => {
    const res = await request(app.getHttpServer())
      .post('/reconciliation/start-daily')
      .send({ ...BODY, notifyEmail: 'secops@example.com' });

    expect(res.status).toBe(201);
    expect(startDailyReconciliation).toHaveBeenCalledWith({
      ...BODY,
      notifyEmail: 'secops@example.com',
    });
  });

  it('refuses notifySlack with 400, names the webhook instead, and starts nothing', async () => {
    const res = await request(app.getHttpServer())
      .post('/reconciliation/start-daily')
      .send({ ...BODY, notifySlack: 'https://hooks.slack.example/T000/B000/XXX' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(
      'Slack delivery is not available: subscribe a webhook to ' +
        'reconciliation.drift_threshold_exceeded instead (Admin > Webhooks)',
    );
    expect(startDailyReconciliation).not.toHaveBeenCalled();
  });

  const SCHEDULE_UNAVAILABLE =
    'Reconciliation runs start on request: scheduled reconciliation is not available, ' +
    'so leave out cronSchedule and enabled: false';

  it.each([
    ['a cronSchedule', { cronSchedule: '0 2 * * *' }],
    ['enabled: false', { enabled: false }],
    ['enabled: true with a cronSchedule', { enabled: true, cronSchedule: '0 2 * * *' }],
  ])('refuses %s with 400 saying runs start on request, and starts nothing', async (_, extra) => {
    const res = await request(app.getHttpServer())
      .post('/reconciliation/start-daily')
      .send({ ...BODY, ...extra });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(SCHEDULE_UNAVAILABLE);
    expect(startDailyReconciliation).not.toHaveBeenCalled();
  });

  it('starts a run that says enabled: true without a schedule', async () => {
    const res = await request(app.getHttpServer())
      .post('/reconciliation/start-daily')
      .send({ ...BODY, enabled: true });

    expect(res.status).toBe(201);
    expect(startDailyReconciliation).toHaveBeenCalledWith({ ...BODY, enabled: true });
  });

  it('passes the scan scope on: departments and excluded users, trimmed', async () => {
    const res = await request(app.getHttpServer())
      .post('/reconciliation/start-daily')
      .send({
        ...BODY,
        includedDepartments: [' Sales ', 'R&D'],
        excludedUsers: ['ceo@example.com ', '64b7f0c2a1b2c3d4e5f60718'],
      });

    expect(res.status).toBe(201);
    expect(startDailyReconciliation).toHaveBeenCalledWith({
      ...BODY,
      includedDepartments: ['Sales', 'R&D'],
      excludedUsers: ['ceo@example.com', '64b7f0c2a1b2c3d4e5f60718'],
    });
  });

  it.each([
    ['a name', 'Ada Lovelace'],
    ['a sourceUserId', 'EMP-1001'],
    ['an empty entry', '  '],
  ])('refuses an excludedUsers entry that is %s with 400', async (_, entry) => {
    const res = await request(app.getHttpServer())
      .post('/reconciliation/start-daily')
      .send({ ...BODY, excludedUsers: ['ceo@example.com', entry] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(
      'An excludedUsers entry is an identity id (24 hex characters) or an email address',
    );
    expect(startDailyReconciliation).not.toHaveBeenCalled();
  });

  it('refuses an empty includedDepartments entry with 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/reconciliation/start-daily')
      .send({ ...BODY, includedDepartments: ['Sales', ' '] });

    expect(res.status).toBe(400);
    expect(startDailyReconciliation).not.toHaveBeenCalled();
  });

  // r2-05 N12: a second start while the run is open was a generic 500 "Operation failed"
  it("answers 409 while the tenant's run is still open", async () => {
    startDailyReconciliation.mockRejectedValue(
      new WorkflowExecutionAlreadyStartedError(
        'Workflow execution already started',
        't-default-daily-recon',
        'dailyReconciliationWorkflow',
      ),
    );

    const res = await request(app.getHttpServer()).post('/reconciliation/start-daily').send(BODY);

    expect(res.status).toBe(409);
    expect(res.body.message).toContain('already running');
  });
});

/**
 * The test routes started a real reconciliation with auto-correction on (sample-daily) and
 * created tx.test@test.com in the tenant's Entra ID (sample-transaction), for any operator, in
 * production too (hunt 05 F11). They are gone.
 */
describe('POST /reconciliation/test/*', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReconciliationController],
      providers: [
        { provide: ReconciliationService, useValue: {} },
        { provide: DriftService, useValue: {} },
        { provide: OrphanCleanupService, useValue: {} },
        { provide: ConnectorHealthService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['sample-daily', 'sample-transaction'])('%s does not exist', async (route) => {
    await request(app.getHttpServer()).post(`/reconciliation/test/${route}`).expect(404);
  });

  // 05 F3: one id that is no ObjectId failed the whole request as "Invalid ID format"
  it.each(['bulk-correct', 'bulk-ignore'])(
    '%s refuses an id that is no drift id, naming it',
    async (route) => {
      const res = await request(app.getHttpServer())
        .post(`/reconciliation/drifts/${route}`)
        .send({ driftIds: ['6650bbbbbbbbbbbbbbbbbbbb', 'abc'] })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('24 hex characters');
    },
  );
});
