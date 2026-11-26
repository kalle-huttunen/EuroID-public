import { createHash } from 'crypto';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { InviteService } from './invite.service';
import { Invite } from './schemas/invite.schema';
import { AdminUser } from './schemas/admin-user.schema';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { createMockEventEmitter } from '@testing/test-helpers';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

describe('InviteService', () => {
  let service: InviteService;
  let mockInviteModel: any;
  let mockEventEmitter: ReturnType<typeof createMockEventEmitter>;

  const validCreatedBy = '507f1f77bcf86cd799439011';
  const mockInviteDoc = {
    _id: 'invite-1',
    email: 'newuser@example.com',
    roles: ['operator', 'viewer'],
    tokenHash: 'hashed-token',
    expiresAt: new Date(Date.now() + 86400000),
    used: false,
  };

  beforeEach(async () => {
    mockEventEmitter = createMockEventEmitter();

    mockInviteModel = {
      create: jest.fn().mockResolvedValue({
        ...mockInviteDoc,
        token: undefined,
      }),
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
    };

    const module = await Test.createTestingModule({
      providers: [
        InviteService,
        { provide: getModelToken(Invite.name), useValue: mockInviteModel },
        // No admin account has any of these addresses.
        {
          provide: getModelToken(AdminUser.name),
          useValue: { exists: jest.fn().mockResolvedValue(null) },
        },
        { provide: DomainEventEmitterService, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<InviteService>(InviteService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createInvite', () => {
    it('should filter invalid roles', async () => {
      const { token } = await service.createInvite(
        'newuser@example.com',
        ['operator', 'invalid-role', 'viewer', 'hacker'],
        validCreatedBy,
        'test-tenant',
      );

      expect(mockInviteModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'newuser@example.com',
          roles: expect.arrayContaining(['operator', 'viewer']),
        }),
      );
      const createCall = mockInviteModel.create.mock.calls[0][0];
      expect(createCall.roles).not.toContain('invalid-role');
      expect(createCall.roles).not.toContain('hacker');
      // Stored as its SHA-256 only: whoever reads the invites cannot register with them.
      expect(createCall.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(createCall).not.toHaveProperty('token');
      expect(JSON.stringify(createCall)).not.toContain(token);
    });

    it('should throw BadRequestException when no valid roles', async () => {
      await expect(
        service.createInvite(
          'newuser@example.com',
          ['invalid-role', 'also-invalid'],
          validCreatedBy,
          'test-tenant',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    // The event reaches the audit log, webhooks and Socket.IO: ids and roles, no address
    it('emits INVITE_CREATED with the roles and the inviter, without the email', async () => {
      await service.createInvite(
        'newuser@example.com',
        ['operator'],
        validCreatedBy,
        'test-tenant',
      );

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'invite.created',
        'invite-1',
        { roles: ['operator'], createdBy: validCreatedBy, expiresAt: expect.any(String) },
        { tenantId: 'test-tenant' },
      );
      expect(JSON.stringify(mockEventEmitter.emit.mock.calls)).not.toContain('newuser@example.com');
    });

    // Every domain event lands in the tenant's audit log (readable by viewers), webhooks and
    // Socket.IO; an invite token there would let any reader register with the invited role.
    it('keeps the invite token out of the invite.created event', async () => {
      const { token } = await service.createInvite(
        'newuser@example.com',
        ['super-admin'],
        validCreatedBy,
        'test-tenant',
      );

      expect(mockEventEmitter.emit).toHaveBeenCalledTimes(1);
      const [type, aggregateId] = mockEventEmitter.emit.mock.calls[0];
      expect(type).toBe('invite.created');
      expect(aggregateId).toBe('invite-1');
      expect(JSON.stringify(mockEventEmitter.emit.mock.calls)).not.toContain(token);
    });

    it('should return token and expiresAt', async () => {
      const result = await service.createInvite(
        'newuser@example.com',
        ['operator'],
        validCreatedBy,
        'test-tenant',
      );

      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe('string');
      expect(result.expiresAt).toBeDefined();
    });
  });

  describe('redeemInvite', () => {
    const invite = {
      _id: 'invite-1',
      email: 'newuser@example.com',
      roles: ['operator', 'viewer'],
      tenantId: 'inviting-tenant',
    };
    let release: { setOptions: jest.Mock; catch: jest.Mock };

    beforeEach(() => {
      mockInviteModel.findOne = jest.fn().mockResolvedValue(invite);
      mockInviteModel.findOneAndUpdate.mockResolvedValue(invite);
      release = {
        setOptions: jest.fn(() => release),
        catch: jest.fn(() => Promise.resolve(undefined)),
      };
      mockInviteModel.updateOne = jest.fn(() => release);
    });

    it('runs register with what the invite grants and uses the invite up', async () => {
      const register = jest.fn().mockResolvedValue('admin-1');

      await expect(
        service.redeemInvite('valid-token', ' NewUser@example.com ', register),
      ).resolves.toBe('admin-1');

      expect(register).toHaveBeenCalledWith({
        email: 'newuser@example.com',
        roles: ['operator', 'viewer'],
        tenantId: 'inviting-tenant',
      });
      // Claimed only while still unused and unexpired, so a concurrent redeem cannot claim it too.
      expect(mockInviteModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'invite-1', usedAt: { $exists: false } }),
        expect.objectContaining({ $set: expect.objectContaining({ usedAt: expect.any(Date) }) }),
        expect.objectContaining({ skipTenantScope: true }),
      );
      expect(mockInviteModel.updateOne).not.toHaveBeenCalled();
    });

    it('accepts a legacy plaintext-token invite and moves it to tokenHash', async () => {
      mockInviteModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(invite);

      await service.redeemInvite('legacy-token', invite.email, jest.fn());

      expect(mockInviteModel.findOne).toHaveBeenLastCalledWith(
        expect.objectContaining({ token: 'legacy-token' }),
        null,
        expect.objectContaining({ skipTenantScope: true }),
      );
      expect(mockInviteModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $set: expect.objectContaining({ tokenHash: expect.any(String) }),
          $unset: { token: 1 },
        }),
        expect.anything(),
      );
    });

    it('releases the invite when register fails, and rethrows', async () => {
      const failure = new Error('E11000 duplicate key');

      await expect(
        service.redeemInvite('valid-token', invite.email, jest.fn().mockRejectedValue(failure)),
      ).rejects.toBe(failure);

      const [[claimFilter, claimUpdate]] = mockInviteModel.findOneAndUpdate.mock.calls;
      expect(mockInviteModel.updateOne).toHaveBeenCalledWith(
        // Only the claim this call made: same invite, same usedAt.
        { _id: claimFilter._id, usedAt: claimUpdate.$set.usedAt },
        { $unset: { usedAt: 1 } },
      );
      expect(release.setOptions).toHaveBeenCalledWith({ skipTenantScope: true });
    });
  });
});
