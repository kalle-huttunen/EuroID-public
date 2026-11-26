import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ReconciliationConfig } from './schemas/reconciliation-config.schema';
import { ReconciliationConfigService } from './reconciliation-config.service';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

describe('ReconciliationConfigService', () => {
  let service: ReconciliationConfigService;
  let mockConfigModel: Record<string, jest.Mock>;

  const mockConfig = {
    tenantId: 'test-tenant',
    hrSourceTags: ['workday', 'bamboo'],
    reconciliationInterval: 3600,
  };

  beforeEach(async () => {
    mockConfigModel = {
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockConfig),
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(mockConfig),
        }),
      }),
      findOneAndUpdate: jest.fn().mockResolvedValue(mockConfig),
    };

    const module = await Test.createTestingModule({
      providers: [
        ReconciliationConfigService,
        {
          provide: getModelToken(ReconciliationConfig.name),
          useValue: mockConfigModel,
        },
      ],
    }).compile();

    service = module.get(ReconciliationConfigService);
  });

  describe('getConfig', () => {
    it('should return config when found', async () => {
      const result = await service.getConfig('test-tenant');

      expect(result).toEqual(mockConfig);
      expect(mockConfigModel.findOne).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
      });
    });

    it('should return null when not found', async () => {
      mockConfigModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      });

      const result = await service.getConfig('missing-tenant');

      expect(result).toBeNull();
    });
  });

  describe('upsertConfig', () => {
    it('should upsert with correct params', async () => {
      const dto = { reconciliationInterval: 7200 };

      await service.upsertConfig('test-tenant', dto as any);

      expect(mockConfigModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: 'test-tenant' },
        {
          $set: expect.objectContaining({ reconciliationInterval: 7200, tenantId: 'test-tenant' }),
        },
        expect.objectContaining({ upsert: true }),
      );
    });
  });

  describe('getHrSourceTags', () => {
    it('should return tags when config exists', async () => {
      const result = await service.getHrSourceTags('test-tenant');

      expect(result).toEqual(['workday', 'bamboo']);
      expect(mockConfigModel.findOne).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
      });
      // Reads the tags only, not the whole config
      expect(mockConfigModel.findOne.mock.results[0].value.select).toHaveBeenCalledWith(
        'hrSourceTags',
      );
    });

    it('should return empty array when config not found', async () => {
      mockConfigModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
        select: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      });

      const result = await service.getHrSourceTags('missing-tenant');

      expect(result).toEqual([]);
    });
  });
});
