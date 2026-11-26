/**
 * POST /identity (IdentityController.create) with a stubbed identity service.
 *
 * Hunt 2026-11-25 02 F17: every create error became 500 "Operation failed", a record held for a
 * conflict review (409), the source limit (400), a duplicate email and unreadable correlation
 * settings (503) included, so a client could not tell "retry later" or "conflict" from a bug.
 * 02 F3: the body's sourceSystem was taken as it came, so an operator could write as an HR
 * source (its records reconcile as HR: overwrite rule, primary contract, no mastery check).
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { withTestTenant } from '@testing';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { IdentityController } from './identity.controller';
import type { IdentityService } from './identity.service';
import type { UserEventService } from './user-event.service';
import type { IdentityEntitlementsService } from './identity-entitlements.service';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { AuditService } from '../audit/audit.service';
import { RowHeldForConflictReview } from './conflict-held-rows';
import { IdentityLimitReached } from './identity-limit';
import { CorrelationConfigUnavailableError } from '../correlation-config/correlation-config.errors';
import type { CreateUserDto } from './dtos/create-user.dto';

const body = {
  sourceSystem: 'Manual-Test',
  sourceUserId: 'test-1',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@corp.example',
  status: UserStatus.PENDING,
} as CreateUserDto;

describe('POST /identity errors', () => {
  const identityService = {
    create: jest.fn(),
    isHrSource: jest.fn().mockResolvedValue(false),
  };
  const controller = new IdentityController(
    identityService as unknown as IdentityService,
    {} as UserEventService,
    {} as DomainEventEmitterService,
    {} as AuditService,
    {} as IdentityEntitlementsService,
  );
  const createWith = async (error: unknown): Promise<unknown> => {
    identityService.create.mockRejectedValueOnce(error);
    return Promise.resolve(withTestTenant(() => controller.create({ ...body }))).then(
      () => undefined,
      (err: unknown) => err,
    );
  };

  beforeEach(() => {
    identityService.create.mockReset();
    identityService.isHrSource.mockResolvedValue(false);
  });

  it('answers a record held for a conflict review with its 409', async () => {
    const err = await createWith(new RowHeldForConflictReview('64b7f0c2a1b2c3d4e5f60718'));
    expect(err).toBeInstanceOf(RowHeldForConflictReview);
    expect((err as HttpException).getStatus()).toBe(409);
  });

  it("answers the tenant's identity limit with 409 naming it", async () => {
    const err = await createWith(new IdentityLimitReached(500));
    expect((err as HttpException).getStatus()).toBe(409);
    expect((err as Error).message).toMatch(/identity limit \(500\)/);
  });

  it('answers the source limit with its 400', async () => {
    const err = await createWith(new BadRequestException('Identity sources array exceeds'));
    expect((err as HttpException).getStatus()).toBe(400);
  });

  it('answers 503 when the correlation settings cannot be read', async () => {
    const err = await createWith(new CorrelationConfigUnavailableError());
    expect((err as HttpException).getStatus()).toBe(503);
  });

  it('answers 409 naming the field when another identity has the email', async () => {
    const duplicate = Object.assign(new Error('E11000 duplicate key error'), {
      code: 11000,
      keyPattern: { tenantId: 1, 'profile.email': 1 },
      keyValue: { tenantId: 't', 'profile.email': 'ada@corp.example' },
    });
    const err = await createWith(duplicate);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as HttpException).message).toContain('email');
    expect((err as HttpException).message).not.toContain('ada@corp.example');
  });

  it('still answers 500 for an unexpected error', async () => {
    const err = await createWith(new Error('boom'));
    expect(err).toBeInstanceOf(InternalServerErrorException);
  });

  it('refuses a sourceSystem that is an HR source of the tenant and creates nothing', async () => {
    identityService.isHrSource.mockResolvedValue(true);

    const err = await Promise.resolve(
      withTestTenant(() =>
        controller.create({ ...body, sourceSystem: 'csv-hr', sourceUserId: 'E-100' }),
      ),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as HttpException).message).toContain('csv-hr');
    expect(identityService.isHrSource).toHaveBeenCalledWith('csv-hr');
    expect(identityService.create).not.toHaveBeenCalled();
  });
});
