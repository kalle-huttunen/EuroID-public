/**
 * SCIM routes answer every error in SCIM's error model (RFC 7644 section 3.12). Hunt 2026-11-25
 * (02 F13): a duplicate email on PUT or PATCH (MongoDB E11000) and an id that is no ObjectId
 * (CastError) answered 500; they now answer 409 uniqueness and 404.
 */
import type { ArgumentsHost } from '@nestjs/common';
import mongoose from 'mongoose';
import { z } from 'zod';
import { SCIMErrorFilter } from './scim.error';

function answerTo(exception: unknown): { status: number; body: Record<string, unknown> } {
  const answer = { status: 0, body: {} as Record<string, unknown> };
  const response = {
    status: (code: number) => {
      answer.status = code;
      return response;
    },
    contentType: () => response,
    json: (body: Record<string, unknown>) => {
      answer.body = body;
    },
  };
  new SCIMErrorFilter().catch(exception, {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost);
  return answer;
}

describe('SCIMErrorFilter', () => {
  it('answers a duplicate key as 409 uniqueness, naming no value', () => {
    const duplicate = Object.assign(
      new Error(
        'E11000 duplicate key error collection: identities index: profile.email_1 dup key: { "a@x.fi" }',
      ),
      { code: 11000, name: 'MongoServerError' },
    );

    const { status, body } = answerTo(duplicate);

    expect(status).toBe(409);
    expect(body).toMatchObject({ scimType: 'uniqueness', status: '409' });
    expect(JSON.stringify(body)).not.toContain('a@x.fi');
  });

  // Package HX-B's follow-up: a ZodError the controller did not catch answered 500
  it('answers a validation error as 400 invalidValue', () => {
    const invalid = z.object({ count: z.number().max(100) }).safeParse({ count: 500 });

    expect(answerTo(invalid.success ? null : invalid.error)).toMatchObject({
      status: 400,
      body: { scimType: 'invalidValue', status: '400' },
    });
  });

  it('answers an id that is no ObjectId as 404', () => {
    const cast = new mongoose.Error.CastError('ObjectId', 'not-an-id', '_id');

    expect(answerTo(cast)).toMatchObject({
      status: 404,
      body: { status: '404', detail: 'Resource not found' },
    });
  });

  it('still answers an unknown error as 500 without its message', () => {
    expect(answerTo(new Error('secret detail'))).toMatchObject({
      status: 500,
      body: { detail: 'Internal server error' },
    });
  });
});
