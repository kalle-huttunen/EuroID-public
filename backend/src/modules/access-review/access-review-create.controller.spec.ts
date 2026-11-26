/**
 * HTTP contract of creating an access review campaign (POST /access-reviews/campaigns, the
 * global ZodValidationPipe as main.ts registers it).
 *
 * Hunt 04 F13: the controller built the service DTO without `targetEmploymentTypes`, which the
 * schema accepted, so every API-made campaign reviewed only the default human types and service
 * and admin accounts were never reviewed. `deadline` was any string: an unreadable one failed at
 * save, and a past one expired every item at once (and revoked them with autoRevokeOnExpiry).
 */
import { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import * as request from 'supertest';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { AccessReviewController } from './access-review.controller';
import { AccessReviewService } from './access-review.service';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('Create an access review campaign: HTTP API', () => {
  let app: INestApplication;
  const reviews = { createCampaign: jest.fn(async () => ({ campaignId: 'camp-1' })) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccessReviewController],
      providers: [{ provide: AccessReviewService, useValue: reviews }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const inTenDays = () => new Date(Date.now() + 10 * DAY_MS).toISOString();
  const create = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/access-reviews/campaigns')
      .send({ name: 'Machine accounts', scope: { type: 'all' }, ...body });

  it('passes the employment types to review to the service', async () => {
    const res = await create({
      deadline: inTenDays(),
      targetEmploymentTypes: ['SERVICE_ACCOUNT', 'ADMIN_ACCOUNT'],
    });

    expect(res.status).toBe(201);
    expect(reviews.createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ targetEmploymentTypes: ['SERVICE_ACCOUNT', 'ADMIN_ACCOUNT'] }),
      expect.anything(),
    );
  });

  it.each([
    ['an unknown employment type', { targetEmploymentTypes: ['ROBOT'] }],
    ['an empty list of employment types', { targetEmploymentTypes: [] }],
    ['a deadline that is not a date', { deadline: 'next friday' }],
    ['a deadline in the past', { deadline: new Date(Date.now() - DAY_MS).toISOString() }],
  ])('refuses %s with 400', async (_case, body) => {
    const res = await create({ deadline: inTenDays(), ...body });

    expect(res.status).toBe(400);
    expect(reviews.createCampaign).not.toHaveBeenCalled();
  });

  it('takes a deadline with an offset, and none (30 days ahead)', async () => {
    const withOffset = new Date(Date.now() + 10 * DAY_MS).toISOString().replace('Z', '+02:00');
    expect((await create({ deadline: withOffset })).status).toBe(201);
    expect((await create({})).status).toBe(201);
  });
});
