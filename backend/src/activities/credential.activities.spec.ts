import { Test } from '@nestjs/testing';
import { CredentialActivities } from './credential.activities';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { AdService } from '../modules/connectors/ad-connector/ad.service';
import { TEST_TENANT_ID } from '@testing/test-helpers';

describe('CredentialActivities', () => {
  let activities: CredentialActivities;
  let entraService: jest.Mocked<Partial<EntraService>>;
  let adService: jest.Mocked<Partial<AdService>>;

  beforeEach(async () => {
    entraService = {
      getCredentialState: jest.fn().mockResolvedValue({
        lastPasswordChange: new Date('2026-01-01'),
        accountEnabled: true,
        passwordExpired: false,
      }),
      getMfaStatus: jest.fn().mockResolvedValue({
        enrolled: true,
        methods: ['microsoftAuthenticator'],
      }),
    };

    adService = {
      getCredentialState: jest.fn().mockResolvedValue({
        lastPasswordChange: new Date('2026-01-15'),
        accountEnabled: true,
        passwordExpired: false,
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        CredentialActivities,
        { provide: EntraService, useValue: entraService },
        { provide: AdService, useValue: adService },
      ],
    }).compile();

    activities = module.get(CredentialActivities);
  });

  describe('getEntraCredentialState', () => {
    it('should return credential state from Entra', async () => {
      const result = await activities.getEntraCredentialState('ext-123', TEST_TENANT_ID);

      expect(result).toEqual(
        expect.objectContaining({
          accountEnabled: true,
          passwordExpired: false,
        }),
      );
      expect(entraService.getCredentialState).toHaveBeenCalledWith('ext-123');
    });
  });

  describe('getAdCredentialState', () => {
    const adConfig = { host: 'ldap://dc.example.com', baseDn: 'DC=example,DC=com' } as any;

    it('should return credential state from AD', async () => {
      const result = await activities.getAdCredentialState('dn', adConfig, TEST_TENANT_ID);

      expect(result).toEqual(
        expect.objectContaining({
          accountEnabled: true,
        }),
      );
    });

    it('should return null when AD config is missing', async () => {
      const result = await activities.getAdCredentialState('dn', undefined, TEST_TENANT_ID);

      expect(result).toBeNull();
    });
  });

  describe('getEntraMfaStatus', () => {
    it('should return MFA status from Entra', async () => {
      const result = await activities.getEntraMfaStatus('ext-123', TEST_TENANT_ID);

      expect(result).toEqual(
        expect.objectContaining({
          enrolled: true,
          methods: ['microsoftAuthenticator'],
        }),
      );
    });

    it('should return null when getMfaStatus is not available', async () => {
      // Remove getMfaStatus from service
      delete (entraService as any).getMfaStatus;

      const result = await activities.getEntraMfaStatus('ext-123', TEST_TENANT_ID);

      expect(result).toBeNull();
    });
  });
});
