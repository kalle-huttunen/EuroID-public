import { Test, TestingModule } from '@nestjs/testing';
import { ScimFilterService } from './scim-filter.service';
import { SCIMError } from '@shared/scim';
import { UserStatus } from '@shared/dtos/standard-user.dto';

describe('ScimFilterService', () => {
  let service: ScimFilterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ScimFilterService],
    }).compile();
    service = module.get<ScimFilterService>(ScimFilterService);
  });

  describe('parseFilter', () => {
    // The identity keeps these under profile. (hunt 2026-11-25, 02 F1); the query against real
    // identities is in scim-users-filter.integration.spec.ts
    it('maps userName eq to the UPN, else the email, equal in any case', () => {
      const exact = { $regex: '^john@x\\.fi$', $options: 'i' };
      expect(service.parseFilter('userName eq "john@x.fi"')).toEqual({
        $or: [
          { 'profile.userPrincipalName': exact },
          { 'profile.userPrincipalName': null, 'profile.email': exact },
        ],
      });
    });

    it('maps displayName co to a case-insensitive regex on profile.displayName', () => {
      expect(service.parseFilter('displayName co "John"')).toEqual({
        'profile.displayName': { $regex: 'John', $options: 'i' },
      });
    });

    it('maps emails.value sw to a start-with regex on profile.email', () => {
      expect(service.parseFilter('emails.value sw "john"')).toEqual({
        'profile.email': { $regex: '^john', $options: 'i' },
      });
    });

    it('maps active eq "true" to the statuses the response shows active', () => {
      expect(service.parseFilter('active eq "true"')).toEqual({
        'profile.status': { $in: [UserStatus.ACTIVE, UserStatus.PENDING] },
      });
    });

    it('maps active eq "false" to every other status', () => {
      expect(service.parseFilter('active eq "false"')).toEqual({
        'profile.status': { $nin: [UserStatus.ACTIVE, UserStatus.PENDING] },
      });
    });

    it('should throw SCIMError for unsupported filter attribute', () => {
      expect(() => service.parseFilter('unknownAttr eq "x"')).toThrow(SCIMError);
      expect(() => service.parseFilter('unknownAttr eq "x"')).toThrow(
        /Unsupported SCIM filter attribute/,
      );
    });

    it('should return empty query for empty/null filter', () => {
      expect(service.parseFilter('')).toEqual({});
      expect(service.parseFilter('   ')).toEqual({});
    });
  });
});
