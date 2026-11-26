/**
 * Express 5 leaves `req.body` undefined for a request without a body (Express 4 gave `{}`), so a
 * route whose body DTO has only optional fields answered 400 ": Required" to a POST without a
 * body. `emptyBodyAsObject` gives such a request an empty object, as the routes were written for.
 */
import { Body, Controller, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe, createZodDto } from '@anatine/zod-nestjs';
import * as request from 'supertest';
import { z } from 'zod';
import { emptyBodyAsObject } from './empty-body.middleware';

class OptionalBodyDto extends createZodDto(z.object({ reason: z.string().max(10).optional() })) {}
class RequiredBodyDto extends createZodDto(z.object({ name: z.string() })) {}

@Controller('probe')
class ProbeController {
  @Post('optional')
  optional(@Body() body: OptionalBodyDto) {
    return { body };
  }

  @Post('required')
  required(@Body() body: RequiredBodyDto) {
    return { body };
  }
}

describe('emptyBodyAsObject (HTTP)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use(emptyBodyAsObject);
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a POST without a body where every body field is optional', async () => {
    const res = await request(app.getHttpServer()).post('/probe/optional').expect(201);

    expect(res.body).toEqual({ body: {} });
  });

  it('still hands a JSON body to the route', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/optional')
      .send({ reason: 'checked' })
      .expect(201);

    expect(res.body).toEqual({ body: { reason: 'checked' } });
  });

  it('still refuses an invalid field', async () => {
    await request(app.getHttpServer())
      .post('/probe/optional')
      .send({ reason: 'longer than ten characters' })
      .expect(400);
  });

  it('names the missing field when a required body is not sent', async () => {
    const res = await request(app.getHttpServer()).post('/probe/required').expect(400);

    expect(JSON.stringify(res.body)).toContain('name');
  });
});
