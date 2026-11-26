/**
 * POST /identity/:id/consent at the API boundary (HTTP, the global ZodValidationPipe): an
 * `expiresAt` that is not a date is a 400 that names the field and the format, before the service
 * runs. Before, it reached Mongoose, whose failed date cast answered 500.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import * as request from 'supertest';
import { GdprComplianceController } from './gdpr-compliance.controller';
import { ConsentService } from './consent.service';
import { GdprErasureService } from './gdpr-erasure.service';
import { DsarExportService } from './dsar-export.service';

const ID = '64b7f0c2a1b2c3d4e5f60a01';

describe('POST /identity/:id/consent validation (HTTP)', () => {
  let app: INestApplication;
  const consentService = { grantConsent: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [GdprComplianceController],
      providers: [
        { provide: ConsentService, useValue: consentService },
        { provide: GdprErasureService, useValue: {} },
        { provide: DsarExportService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    consentService.grantConsent.mockReset().mockResolvedValue({ purpose: 'marketing' });
  });

  it.each(['31.12.2026', 'next year', ''])(
    'refuses expiresAt %p with 400 and what to send, without recording anything',
    async (expiresAt) => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/identity/${ID}/consent`)
        .send({ purpose: 'marketing', expiresAt })
        .expect(400);

      expect(res.body.message).toEqual([
        'expiresAt: must be a date, e.g. 2026-12-31 or 2026-12-31T23:59:59.999Z',
      ]);
      expect(consentService.grantConsent).not.toHaveBeenCalled();
    },
  );

  it('takes a date, and a grant without one', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/identity/${ID}/consent`)
      .send({ purpose: 'marketing', expiresAt: '2026-12-31T23:59:59.999Z' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/identity/${ID}/consent`)
      .send({ purpose: 'analytics' })
      .expect(201);

    expect(consentService.grantConsent).toHaveBeenNthCalledWith(
      1,
      ID,
      { purpose: 'marketing', expiresAt: '2026-12-31T23:59:59.999Z' },
      'unknown',
    );
    expect(consentService.grantConsent).toHaveBeenNthCalledWith(
      2,
      ID,
      { purpose: 'analytics' },
      'unknown',
    );
  });
});
