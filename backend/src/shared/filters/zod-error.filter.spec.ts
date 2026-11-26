/**
 * Request bodies that controllers and services validate with `Schema.parse()` answer 400 naming
 * each invalid field, with the global filters registered as main.ts registers them. Before
 * ZodErrorFilter the thrown ZodError reached the catch-all and answered 500.
 */

import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { z } from 'zod';
import { authConfig } from '@infrastructure/config/auth.config';
import { globalExceptionFilters } from './global-exception-filters';
import { BlueprintsController } from '../../modules/blueprints/blueprints.controller';
import { BlueprintsService } from '../../modules/blueprints/blueprints.service';
import { ImpactAnalysisService } from '../../modules/blueprints/impact-analysis.service';
import { PipelineService } from '../../modules/blueprints/pipeline.service';
import { IdentityService } from '../../modules/identity/identity.service';
import { EntraService } from '../../modules/connectors/entra-connector/entra.service';
import { SodPolicyController } from '../../modules/policy/sod-policy.controller';
import { SodService } from '../../modules/policy/sod.service';
import { EventSubscriptionController } from '../../modules/event-subscriptions/event-subscription.controller';
import { EventSubscriptionService } from '../../modules/event-subscriptions/event-subscription.service';
import { EventDeliveryService } from '../../modules/event-subscriptions/event-delivery.service';
import { DeliveryAttempt } from '../../modules/event-subscriptions/schemas/delivery-attempt.schema';

const ProbeSchema = z.object({
  name: z.string().min(1),
  limit: z.number().int().max(10).optional(),
  contact: z.object({ email: z.string().email() }).optional(),
});

/** Throws what real handlers throw: a ZodError from parse(). */
@Controller('probe')
class ProbeController {
  @Post('parse')
  parse(@Body() body: unknown) {
    return ProbeSchema.parse(body);
  }

  @Post('parse-async')
  async parseAsync(@Body() body: unknown) {
    await Promise.resolve();
    return ProbeSchema.parseAsync(body);
  }
}

type EventSubscriptionCtor = ConstructorParameters<typeof EventSubscriptionService>;

describe('ZodErrorFilter (global filters as in main.ts)', () => {
  let app: INestApplication;
  const sodService = { create: jest.fn() };
  const blueprintsService = { updateNodeConfig: jest.fn(), toMaskedNode: jest.fn() };
  const impactAnalysisService = { computeDeltas: jest.fn() };
  const subscriptionModel = { countDocuments: jest.fn(), create: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        ProbeController,
        BlueprintsController,
        SodPolicyController,
        EventSubscriptionController,
      ],
      providers: [
        { provide: BlueprintsService, useValue: blueprintsService },
        { provide: ImpactAnalysisService, useValue: impactAnalysisService },
        { provide: PipelineService, useValue: {} },
        { provide: IdentityService, useValue: {} },
        { provide: EntraService, useValue: {} },
        { provide: authConfig.KEY, useValue: { DEFAULT_TENANT_ID: 'tenant-a' } },
        { provide: SodService, useValue: sodService },
        {
          // The real service: it parses the body itself.
          provide: EventSubscriptionService,
          useValue: new EventSubscriptionService(
            subscriptionModel as unknown as EventSubscriptionCtor[0],
            {} as EventSubscriptionCtor[1],
            { get: jest.fn() } as unknown as EventSubscriptionCtor[2],
            { emit: jest.fn() } as unknown as EventSubscriptionCtor[3],
          ),
        },
        { provide: getModelToken(DeliveryAttempt.name), useValue: {} },
        { provide: EventDeliveryService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  const post = (path: string, body: object = {}) =>
    request(app.getHttpServer()).post(path).send(body);

  describe('mechanism', () => {
    it.each(['/probe/parse', '/probe/parse-async'])(
      'answers a ZodError thrown by %s with 400 and one message per field',
      async (path) => {
        const res = await post(path, { limit: 11, contact: { email: 'not-an-email' } });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          message: [
            'name: Required',
            'limit: Number must be less than or equal to 10',
            'contact.email: Invalid email',
          ],
        });
      },
    );

    it('names the body itself when the body is not an object', async () => {
      const res = await request(app.getHttpServer()).post('/probe/parse').send(['a', 'b']);

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual(['body: Expected object, received array']);
    });

    it('passes a valid body through', async () => {
      await post('/probe/parse', { name: 'ok', limit: 3 }).expect(201, { name: 'ok', limit: 3 });
    });
  });

  describe('representative routes', () => {
    it('PATCH /blueprints/:id with a bad body is 400 naming the field, and changes nothing', async () => {
      const res = await request(app.getHttpServer())
        .patch('/blueprints/507f1f77bcf86cd799439011')
        .send({ config: { tenantUrl: { nested: 'object' } } });

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual([expect.stringMatching(/^config\.tenantUrl: /)]);
      expect(blueprintsService.updateNodeConfig).not.toHaveBeenCalled();
    });

    it('POST /blueprints/impact-analysis with a bad body is 400 naming the field', async () => {
      const res = await post('/blueprints/impact-analysis', { users: [], dryRun: 'yes' });

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^users: /),
          expect.stringMatching(/^dryRun: /),
        ]),
      );
      expect(impactAnalysisService.computeDeltas).not.toHaveBeenCalled();
    });

    it('POST /sod-policies with a bad body is 400 naming the field', async () => {
      const res = await post('/sod-policies', {
        name: 'Payroll vs approval',
        conflictingEntitlements: [{ system: 'sap', type: 'role', targetId: 'payroll' }],
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual([
        'conflictingEntitlements: At least 2 conflicting entitlements required',
      ]);
      expect(sodService.create).not.toHaveBeenCalled();
    });

    it('POST /event-subscriptions (parsed in the service) with a bad body is 400', async () => {
      const res = await post('/event-subscriptions', {
        name: 'Audit feed',
        filters: { eventTypes: ['identity.created'] },
        webhook: { url: 'not a url', signingSecret: 'short' },
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^webhook\.url: /),
          expect.stringMatching(/^webhook\.signingSecret: /),
        ]),
      );
      expect(subscriptionModel.create).not.toHaveBeenCalled();
    });
  });
});
