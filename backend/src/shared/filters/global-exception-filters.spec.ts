/**
 * The global filters as main.ts registers them (globalExceptionFilters): each specific filter
 * answers only its own errors and everything else reaches AllExceptionsFilter, which answers an
 * unknown error with the generic 500 body and logs it. VersionConflictFilter used to catch every
 * exception, so the catch-all never ran: no `Unhandled exception:` log line, and an error object
 * carrying a statusCode and message reached the client with that status and message.
 */
import { Controller, INestApplication, Logger, NotFoundException, Post } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Document, Error as MongooseError } from 'mongoose';
import * as request from 'supertest';
import { globalExceptionFilters } from './global-exception-filters';

@Controller('probe')
class ProbeController {
  @Post('unknown')
  unknown() {
    throw new Error('connection string mongodb://secret@db');
  }

  @Post('upstream')
  upstream() {
    // An SDK error carrying the upstream response: not something to show the client.
    throw Object.assign(new Error('Graph: invalid client secret for tenant t-1'), {
      statusCode: 401,
    });
  }

  @Post('not-found')
  notFound() {
    throw new NotFoundException('Identity not found');
  }

  @Post('stale')
  stale() {
    const doc = { _id: 'doc-1', _doc: { _id: 'doc-1' } } as unknown as Document;
    throw new MongooseError.VersionError(doc, 3, ['status']);
  }

  @Post('bad-id')
  badId() {
    throw new MongooseError.CastError('ObjectId', 'abc', '_id');
  }

  @Post('bad-number')
  badNumber() {
    throw new MongooseError.CastError('Number', 'abc', 'limit');
  }

  @Post('body')
  body() {
    return { ok: true };
  }
}

describe('global exception filters (as main.ts registers them)', () => {
  let app: INestApplication;
  let logError: jest.SpyInstance;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const post = (path: string) => request(app.getHttpServer()).post(path);

  it('answers an unknown error with the generic 500 and logs it as unhandled', async () => {
    const res = await post('/probe/unknown');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(logError).toHaveBeenCalledWith(
      'Unhandled exception: connection string mongodb://secret@db',
      expect.stringContaining('ProbeController.unknown'),
    );
  });

  it('does not pass an error object’s own status and message to the client', async () => {
    const res = await post('/probe/upstream');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(logError).toHaveBeenCalledWith(
      'Unhandled exception: Graph: invalid client secret for tenant t-1',
      expect.any(String),
    );
  });

  it('keeps the status and message of an HttpException', async () => {
    const res = await post('/probe/not-found');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Identity not found',
    });
  });

  it('keeps body parsing client errors: 413 for a body over the limit', async () => {
    const res = await post('/probe/body').send({ blob: 'x'.repeat(200 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ statusCode: 413, message: 'request entity too large' });
  });

  it('answers the Mongoose errors with answers of their own: 409 and 400', async () => {
    await post('/probe/stale').expect(409, {
      statusCode: 409,
      message: 'This record was modified by another user. Please refresh and try again.',
    });
    await post('/probe/bad-id').expect(400, { statusCode: 400, message: 'Invalid ID format' });
    expect(logError).not.toHaveBeenCalledWith(
      expect.stringContaining('Unhandled exception'),
      expect.anything(),
    );
  });

  it('answers any other Mongoose error like an unknown one', async () => {
    const res = await post('/probe/bad-number');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled exception: Cast to Number failed'),
      expect.any(String),
    );
  });
});
