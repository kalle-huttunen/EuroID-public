import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { UserEvent } from './schemas/user-event.schema';
import { UserEventService } from './user-event.service';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

describe('UserEventService', () => {
  let service: UserEventService;
  let mockEventModel: Record<string, jest.Mock>;

  const mockEvent = {
    _id: 'event-1',
    userId: 'user-1',
    type: 'LOGIN',
    severity: 'info',
    title: 'User logged in',
    description: 'Successful login',
    actor: 'system',
    targetSystem: 'entra-id',
    timestamp: new Date('2026-01-01'),
  };

  beforeEach(async () => {
    mockEventModel = {
      create: jest.fn().mockResolvedValue(mockEvent),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue([mockEvent]),
          }),
        }),
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        UserEventService,
        {
          provide: getModelToken(UserEvent.name),
          useValue: mockEventModel,
        },
      ],
    }).compile();

    service = module.get(UserEventService);
  });

  describe('recordEvent', () => {
    it('should create event with default severity info', async () => {
      const dto = {
        userId: 'user-1',
        type: 'LOGIN',
        title: 'User logged in',
        actor: 'system',
      };

      await service.recordEvent(dto as any);

      expect(mockEventModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          type: 'LOGIN',
          title: 'User logged in',
          actor: 'system',
          severity: 'info',
        }),
      );
    });

    it('should create event with specified severity', async () => {
      const dto = {
        userId: 'user-1',
        type: 'ACCOUNT_LOCKED',
        severity: 'warning',
        title: 'Account locked',
        actor: 'system',
      };

      await service.recordEvent(dto as any);

      expect(mockEventModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'warning',
        }),
      );
    });

    it('should throw when create fails', async () => {
      mockEventModel.create.mockRejectedValue(new Error('DB error'));

      const dto = {
        userId: 'user-1',
        type: 'LOGIN',
        title: 'User logged in',
        actor: 'system',
      };

      await expect(service.recordEvent(dto as any)).rejects.toThrow('DB error');
    });
  });

  describe('getEvents', () => {
    it('should return events for user', async () => {
      const result = await service.getEvents('user-1');

      expect(result).toEqual([mockEvent]);
      // That user's events only, newest first
      expect(mockEventModel.find).toHaveBeenCalledWith({ userId: 'user-1' });
      expect(mockEventModel.find.mock.results[0].value.sort).toHaveBeenCalledWith({
        timestamp: -1,
      });
    });

    it('should apply type filter when given a single type', async () => {
      await service.getEvents('user-1', { type: 'USER_CREATED' });

      expect(mockEventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', type: 'USER_CREATED' }),
      );
    });

    it('should apply type filter when given an array', async () => {
      await service.getEvents('user-1', {
        type: ['USER_CREATED', 'USER_UPDATED'],
      });

      expect(mockEventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          type: { $in: ['USER_CREATED', 'USER_UPDATED'] },
        }),
      );
    });

    it('should apply date range filter', async () => {
      const dateFrom = '2026-01-01T00:00:00.000Z';
      const dateTo = '2026-01-31T00:00:00.000Z';

      await service.getEvents('user-1', { dateFrom, dateTo });

      expect(mockEventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          timestamp: { $gte: new Date(dateFrom), $lte: new Date(dateTo) },
        }),
      );
    });

    it('should use default limit of 50', async () => {
      await service.getEvents('user-1');

      const sortReturn = mockEventModel.find.mock.results[0].value.sort.mock.results[0].value;
      expect(sortReturn.limit).toHaveBeenCalledWith(50);
    });
  });
});
