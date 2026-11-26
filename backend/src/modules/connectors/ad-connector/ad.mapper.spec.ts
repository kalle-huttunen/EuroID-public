import { toAdUser, toDn, generateSamAccountName } from './ad.mapper';
import { createMockUser } from '@testing/mock-factories';
import type { AdConfig } from './ad.interface';
import { EmploymentType, UserStatus } from '@shared/dtos/standard-user.dto';
import { PAM_SOURCE_SYSTEM } from '@shared/utils/linked-admin-profile';

const mockConfig: AdConfig = {
  host: '10.0.0.1',
  baseDn: 'OU=Helsinki,DC=gov,DC=fi',
  serviceAccount: 'CN=svc,OU=SA,DC=gov,DC=fi',
  password: 'secret',
  useLdaps: true,
  defaultDomain: 'gov.fi',
  userOu: 'OU=Users',
};

describe('AdMapper', () => {
  describe('toAdUser', () => {
    it('maps StandardUserDto to AdUserDto', () => {
      const user = createMockUser({
        firstName: 'John',
        lastName: 'Doe',
        displayName: 'John Doe',
        email: 'john.doe@example.com',
      });
      const result = toAdUser(user, mockConfig, 'johndoe', 'john.doe@gov.fi');

      expect(result.cn).toBe('John Doe');
      expect(result.sn).toBe('Doe');
      expect(result.givenName).toBe('John');
      expect(result.displayName).toBe('John Doe');
      expect(result.mail).toBe('john.doe@gov.fi');
      expect(result.sAMAccountName).toBe('johndoe');
      expect(result.userPrincipalName).toBe('john.doe@gov.fi');
      expect(result.objectClass).toEqual(['top', 'person', 'organizationalPerson', 'user']);
      expect(result.userAccountControl).toBe(512);
    });

    it('creates a linked admin account disabled (514) unless its session is active', () => {
      const admin = (status: UserStatus) =>
        createMockUser({
          status,
          employmentType: EmploymentType.ADMIN_ACCOUNT,
          sourceSystem: PAM_SOURCE_SYSTEM,
        });
      const uac = (status: UserStatus) =>
        toAdUser(admin(status), mockConfig, 'adm-john', 'adm-john@gov.fi').userAccountControl;
      expect(uac(UserStatus.PENDING)).toBe(514);
      expect(uac(UserStatus.INACTIVE)).toBe(514);
      expect(uac(UserStatus.ACTIVE)).toBe(512);
      // A regular joiner keeps 512 whatever the status, as before
      const joiner = createMockUser({ status: UserStatus.PENDING });
      expect(toAdUser(joiner, mockConfig, 'john', 'john@gov.fi').userAccountControl).toBe(512);
    });

    it('builds displayName from firstName + lastName when missing', () => {
      const user = createMockUser({ displayName: undefined, firstName: 'Jane', lastName: 'Smith' });
      const result = toAdUser(user, mockConfig, 'janesmith', 'jane@gov.fi');
      expect(result.cn).toBe('Jane Smith');
      expect(result.displayName).toBe('Jane Smith');
    });
  });

  describe('toDn', () => {
    it('builds DN with userOu and baseDn', () => {
      const user = createMockUser({ displayName: 'John Doe', firstName: 'John', lastName: 'Doe' });
      const dn = toDn(user, mockConfig, 'johndoe');
      expect(dn).toContain('CN=John Doe');
      expect(dn).toContain('OU=Users');
      expect(dn).toContain('OU=Helsinki,DC=gov,DC=fi');
    });

    it('builds DN without userOu when not configured', () => {
      const config = { ...mockConfig, userOu: undefined };
      const user = createMockUser({ displayName: 'Jane', firstName: 'Jane', lastName: 'Doe' });
      const dn = toDn(user, config, 'janedoe');
      expect(dn).toContain('CN=Jane');
      expect(dn).toContain('OU=Helsinki,DC=gov,DC=fi');
    });

    it('escapes special characters in CN', () => {
      const user = createMockUser({ displayName: 'Doe, John', firstName: 'John', lastName: 'Doe' });
      const dn = toDn(user, mockConfig, 'johndoe');
      expect(dn).toContain('CN=Doe\\, John');
    });
  });

  describe('generateSamAccountName', () => {
    it('uses samAccountName when provided', () => {
      const user = createMockUser({ samAccountName: 'jdoe' });
      expect(generateSamAccountName(user)).toBe('jdoe');
    });

    it('uses email local part when no samAccountName', () => {
      const user = createMockUser({ samAccountName: undefined, email: 'john.doe@example.com' });
      expect(generateSamAccountName(user)).toBe('johndoe');
    });

    it('uses firstname.lastname when email has no local part', () => {
      const user = createMockUser({
        samAccountName: undefined,
        email: '@example.com',
        firstName: 'John',
        lastName: 'Doe',
      });
      expect(generateSamAccountName(user)).toMatch(/^johndoe$/);
    });

    it('truncates to 20 chars', () => {
      const user = createMockUser({
        samAccountName: 'a'.repeat(25),
        email: 'x@x.com',
      });
      expect(generateSamAccountName(user).length).toBeLessThanOrEqual(20);
    });

    it('strips dots from email local part', () => {
      const user = createMockUser({ samAccountName: undefined, email: 'john.doe@example.com' });
      expect(generateSamAccountName(user)).toBe('johndoe');
    });
  });
});
