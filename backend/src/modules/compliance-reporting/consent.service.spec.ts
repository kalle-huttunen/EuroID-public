import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConsentService } from './consent.service';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

describe('ConsentService', () => {
  let service: ConsentService;
  let mockConsentModel: any;
  /** The identity exists in the tenant unless a test says otherwise. */
  const mockIdentityModel = { exists: jest.fn() };

  beforeEach(async () => {
    mockIdentityModel.exists.mockReset().mockReturnValue({
      exec: jest.fn().mockResolvedValue({ _id: 'identity-1' }),
    });
    mockConsentModel = {
      findOneAndUpdate: jest.fn(),
      find: jest.fn(),
      distinct: jest.fn(),
      aggregate: jest.fn(),
      // Marks consents past their expiry `expired` before a read (tested on MongoDB)
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
    };

    const module = await Test.createTestingModule({
      providers: [
        ConsentService,
        { provide: getModelToken('Consent'), useValue: mockConsentModel },
        { provide: getModelToken('Identity'), useValue: mockIdentityModel },
      ],
    }).compile();

    service = module.get(ConsentService);
  });

  describe('grantConsent', () => {
    it('should upsert a consent record', async () => {
      const mockDoc = { _id: 'c1', status: 'granted', purpose: 'marketing' };
      mockConsentModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockDoc),
      });

      const result = await service.grantConsent(
        'identity-1',
        { purpose: 'marketing', method: 'explicit' },
        'admin',
      );

      expect(mockConsentModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: 'test-tenant', identityId: 'identity-1', purpose: 'marketing' },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'granted', method: 'explicit' }),
        }),
        { upsert: true, new: true },
      );
      expect(result).toBe(mockDoc);
    });

    it('answers 404 for an identity that is not in the tenant, and records nothing', async () => {
      mockIdentityModel.exists.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      await expect(
        service.grantConsent('identity-9', { purpose: 'marketing' }, 'admin'),
      ).rejects.toThrow(new NotFoundException('Identity identity-9 not found'));
      expect(mockIdentityModel.exists).toHaveBeenCalledWith({
        _id: 'identity-9',
        tenantId: 'test-tenant',
      });
      expect(mockConsentModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when purpose is empty', async () => {
      await expect(
        service.grantConsent('identity-1', { purpose: '', method: 'explicit' }, 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when purpose is whitespace', async () => {
      await expect(
        service.grantConsent('identity-1', { purpose: '   ', method: 'explicit' }, 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when upsert returns null', async () => {
      mockConsentModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.grantConsent('identity-1', { purpose: 'marketing', method: 'explicit' }, 'admin'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should set expiresAt when provided', async () => {
      const mockDoc = { _id: 'c1', status: 'granted' };
      mockConsentModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockDoc),
      });

      await service.grantConsent(
        'identity-1',
        { purpose: 'analytics', method: 'explicit', expiresAt: '2026-12-31T00:00:00Z' },
        'admin',
      );

      expect(mockConsentModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({ expiresAt: expect.any(Date) }),
        }),
        expect.any(Object),
      );
    });
  });

  describe('revokeConsent', () => {
    it('should set status to revoked', async () => {
      const mockDoc = { _id: 'c1', status: 'revoked' };
      mockConsentModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockDoc),
      });

      const result = await service.revokeConsent('identity-1', 'marketing');

      expect(mockConsentModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: 'test-tenant', identityId: 'identity-1', purpose: 'marketing' },
        { $set: expect.objectContaining({ status: 'revoked' }) },
        { new: true },
      );
      expect(result).toBe(mockDoc);
    });

    it('should throw NotFoundException when consent not found', async () => {
      mockConsentModel.findOneAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(service.revokeConsent('identity-1', 'marketing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listConsents', () => {
    it('should return sorted consents for identity', async () => {
      const mockConsents = [
        { purpose: 'analytics', status: 'granted' },
        { purpose: 'marketing', status: 'revoked' },
      ];
      mockConsentModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue(mockConsents),
          }),
        }),
      });

      const result = await service.listConsents('identity-1');

      expect(mockConsentModel.find).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        identityId: 'identity-1',
      });
      expect(result).toEqual(mockConsents);
    });
  });

  describe('getConsentReport', () => {
    it('should aggregate consent data by purpose', async () => {
      mockConsentModel.distinct.mockReturnValue({
        then: jest.fn().mockImplementation((fn) => Promise.resolve(fn(['id1', 'id2']))),
      });
      mockConsentModel.aggregate.mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          { _id: { purpose: 'marketing', status: 'granted' }, count: 5 },
          { _id: { purpose: 'marketing', status: 'revoked' }, count: 2 },
          { _id: { purpose: 'analytics', status: 'granted' }, count: 3 },
        ]),
      });

      const result = await service.getConsentReport();

      expect(result.tenantId).toBe('test-tenant');
      expect(result.totalIdentities).toBe(2);
      expect(result.byPurpose).toHaveLength(2);
      expect(result.byPurpose).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ purpose: 'marketing', granted: 5, revoked: 2, expired: 0 }),
          expect.objectContaining({ purpose: 'analytics', granted: 3, revoked: 0, expired: 0 }),
        ]),
      );
    });
  });
});
