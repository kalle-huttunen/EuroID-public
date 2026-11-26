/**
 * HTTP contract of cancelling an access review campaign (RolesGuard with the role hierarchy):
 * super-admin only, as the Cancel campaign action in the UI. The body is optional (a request
 * without one, as before, cancels without a reason); a reason is trimmed and 1 to 500 characters.
 * The service's own 400 ("cannot be cancelled") reaches the caller with its message.
 */
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { AccessReviewController } from './access-review.controller';
import { AccessReviewService } from './access-review.service';

/** Stand-in for JwtAuthGuard: the caller's roles come from its (trusted) token. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    req.user = {
      sub: 'user-1',
      email: 'admin@a.example',
      roles: String(req.headers['x-test-roles'] ?? '').split(','),
      tenantId: 'tenant-a',
    };
    return true;
  }
}

const ID = '4b4e1f0e-6c1b-4f5e-9a51-0c2a6b9d0004';
const CANCEL = `/access-reviews/campaigns/${ID}/cancel`;
const CANCELLED = { campaignId: ID, name: 'Q4 review', status: 'CANCELLED' };

describe('Cancel an access review campaign: HTTP API', () => {
  let app: INestApplication;
  const reviews = { cancel: jest.fn(async () => CANCELLED) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccessReviewController],
      providers: [
        { provide: AccessReviewService, useValue: reviews },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
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
    jest.clearAllMocks();
  });

  const as = (roles: string) => ({ 'x-test-roles': roles });

  it.each(['viewer', 'operator', 'policy-admin', 'connector-admin'])(
    '%s gets 403',
    async (role) => {
      await request(app.getHttpServer())
        .post(CANCEL)
        .set(as(role))
        .send({ reason: 'x' })
        .expect(403);
      expect(reviews.cancel).not.toHaveBeenCalled();
    },
  );

  it('a request without a body cancels without a reason, as before', async () => {
    const res = await request(app.getHttpServer()).post(CANCEL).set(as('super-admin')).expect(201);

    expect(res.body).toEqual(CANCELLED);
    expect(reviews.cancel).toHaveBeenCalledWith(ID, undefined);
  });

  it('passes the reason on, trimmed', async () => {
    await request(app.getHttpServer())
      .post(CANCEL)
      .set(as('super-admin'))
      .send({ reason: '  Wrong scope: Finance instead of Sales  ' })
      .expect(201);

    expect(reviews.cancel).toHaveBeenCalledWith(ID, 'Wrong scope: Finance instead of Sales');
  });

  it.each([
    ['a blank reason', { reason: '   ' }],
    ['a reason over 500 characters', { reason: 'x'.repeat(501) }],
    ['a reason that is not text', { reason: 42 }],
  ])('rejects %s with 400 and says which field', async (_label, body) => {
    const res = await request(app.getHttpServer())
      .post(CANCEL)
      .set(as('super-admin'))
      .send(body)
      .expect(400);

    expect(JSON.stringify(res.body.message)).toContain('reason');
    expect(reviews.cancel).not.toHaveBeenCalled();
  });

  it('rejects an id that is not a UUID with 400', async () => {
    await request(app.getHttpServer())
      .post('/access-reviews/campaigns/64b7f0c2a1b2c3d4e5f60a01/cancel')
      .set(as('super-admin'))
      .expect(400);
    expect(reviews.cancel).not.toHaveBeenCalled();
  });

  it("answers the service's refusal with its message", async () => {
    reviews.cancel.mockRejectedValueOnce(
      new BadRequestException(`Campaign ${ID} cannot be cancelled`),
    );

    const res = await request(app.getHttpServer())
      .post(CANCEL)
      .set(as('super-admin'))
      .send({ reason: 'Duplicate of the Q4 campaign' })
      .expect(400);

    expect(res.body.message).toBe(`Campaign ${ID} cannot be cancelled`);
  });
});
