/**
 * HTTP contract of PII masking and the audited reveal: identity responses never carry
 * the clear PII values; POST /identity/:id/pii/reveal is the only way to get one.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import * as request from 'supertest';
import { ROLES_KEY } from '@infrastructure/auth/roles.decorator';
import { IdentityController } from './identity.controller';
import { IdentityPiiController } from './identity-pii.controller';
import { IdentityService } from './identity.service';
import { IdentityPiiService } from './identity-pii.service';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const PERSONAL_EMAIL = 'ada.lovelace@home.example';
const MOBILE = '+358 40 123 4567';

const profile = {
  _id: ID,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@corp.example',
  personalEmail: PERSONAL_EMAIL,
  mobilePhone: MOBILE,
  workPhone: '+358 9 8765 4321',
  officeExtension: '4321',
};

describe('Identity PII masking and reveal (HTTP)', () => {
  let app: INestApplication;
  const identityService = {
    findById: jest.fn(),
    findAllPaginated: jest.fn(),
    findIdentityByIdFormatted: jest.fn(),
    updateWithChanges: jest.fn(),
  };
  const piiService = { reveal: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IdentityController, IdentityPiiController],
      providers: [
        { provide: IdentityService, useValue: identityService },
        { provide: IdentityPiiService, useValue: piiService },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('identity responses are masked by default', () => {
    it('GET /identity/:id', async () => {
      identityService.findById.mockResolvedValue({ ...profile });

      const res = await request(app.getHttpServer()).get(`/api/v1/identity/${ID}`).expect(200);

      expect(res.body).toMatchObject({
        email: 'ada@corp.example',
        personalEmail: 'a•••@home.example',
        mobilePhone: '+358 •• ••• 4567',
        workPhone: '+358 • •••• 4321',
        officeExtension: '••••',
      });
      expect(res.text).not.toContain(PERSONAL_EMAIL);
      expect(res.text).not.toContain(MOBILE);
    });

    it('GET /identity (list)', async () => {
      identityService.findAllPaginated.mockResolvedValue([[{ ...profile }], 1]);

      const res = await request(app.getHttpServer()).get('/api/v1/identity').expect(200);

      expect(res.body[0].personalEmail).toBe('a•••@home.example');
      expect(res.text).not.toContain(PERSONAL_EMAIL);
    });

    it('GET /identity/v2/:id, including raw source data', async () => {
      identityService.findIdentityByIdFormatted.mockResolvedValue({
        found: true,
        identity: {
          _id: ID,
          profile: { email: 'ada@corp.example', personalEmail: PERSONAL_EMAIL },
          sources: [{ sourceName: 'csv-hr', rawData: { personalEmail: PERSONAL_EMAIL } }],
        },
      });

      const res = await request(app.getHttpServer()).get(`/api/v1/identity/v2/${ID}`).expect(200);

      expect(res.body.identity.profile.personalEmail).toBe('a•••@home.example');
      expect(res.body.identity.sources[0].rawData.personalEmail).toBe('a•••@home.example');
      expect(res.text).not.toContain(PERSONAL_EMAIL);
    });

    it('PATCH /identity/:id masks the returned user', async () => {
      identityService.updateWithChanges.mockResolvedValue({
        user: { ...profile, jobTitle: 'Analyst' },
        changedFields: ['jobTitle'],
        previousAttributes: {},
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/identity/${ID}`)
        .send({ jobTitle: 'Analyst' })
        .expect(200);

      expect(res.body.user.mobilePhone).toBe('+358 •• ••• 4567');
      expect(res.text).not.toContain(MOBILE);
    });
  });

  it('refuses to save a masked value back (it would overwrite the stored one)', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/v1/identity/${ID}`)
      .send({ jobTitle: 'Analyst', mobilePhone: '+358 •• ••• 4567' })
      .expect(400);

    expect(res.body.message).toContain('mobilePhone');
    expect(identityService.updateWithChanges).not.toHaveBeenCalled();
  });

  describe('POST /identity/:id/pii/reveal', () => {
    it('returns the clear value, uncached, from the audited reveal', async () => {
      piiService.reveal.mockResolvedValue({
        identityId: ID,
        field: 'personalEmail',
        value: PERSONAL_EMAIL,
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/identity/${ID}/pii/reveal`)
        .send({ field: 'personalEmail' })
        .expect(200);

      expect(res.body).toEqual({ identityId: ID, field: 'personalEmail', value: PERSONAL_EMAIL });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(piiService.reveal).toHaveBeenCalledWith(ID, 'personalEmail', 'unknown');
    });

    it.each(['email', 'firstName', 'profile.personalEmail', ''])(
      'refuses field %j, which is not on the PII allow-list',
      async (field) => {
        await request(app.getHttpServer())
          .post(`/api/v1/identity/${ID}/pii/reveal`)
          .send({ field })
          .expect(400);
        expect(piiService.reveal).not.toHaveBeenCalled();
      },
    );

    it("answers 404 for an identity outside the caller's tenant", async () => {
      piiService.reveal.mockResolvedValue(null);

      await request(app.getHttpServer())
        .post(`/api/v1/identity/${ID}/pii/reveal`)
        .send({ field: 'mobilePhone' })
        .expect(404);
    });

    it('requires the operator role (viewers cannot see PII)', () => {
      expect(Reflect.getMetadata(ROLES_KEY, IdentityPiiController.prototype.reveal)).toEqual([
        'operator',
      ]);
    });
  });
});
