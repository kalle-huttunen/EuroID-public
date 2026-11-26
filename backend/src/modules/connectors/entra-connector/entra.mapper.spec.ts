import { EntraMapper, extractWritebackAttributes } from './entra.mapper';
import { createMockUser } from '@testing';
import { EmploymentType, UserStatus } from '@shared/dtos/standard-user.dto';
import { PAM_SOURCE_SYSTEM } from '@shared/utils/linked-admin-profile';

describe('EntraMapper', () => {
  let mapper: EntraMapper;

  beforeEach(() => {
    mapper = new EntraMapper();
  });

  describe('toEntraProfile', () => {
    it('should map all standard fields correctly', () => {
      const user = createMockUser();
      const result = mapper.toEntraProfile(user, 'FI');

      expect(result.givenName).toBe('John');
      expect(result.surname).toBe('Doe');
      expect(result.displayName).toBe('John Doe');
      expect(result.department).toBe('ENG'); // departmentCode takes priority
      expect(result.jobTitle).toBe('Software Engineer');
      expect(result.usageLocation).toBe('FI'); // countryCode
    });

    it('should use overrideUpn when provided', () => {
      const user = createMockUser();
      const result = mapper.toEntraProfile(user, 'FI', 'custom.upn@example.com');
      expect(result.userPrincipalName).toBe('custom.upn@example.com');
    });

    it('should fall back to userPrincipalName when no override', () => {
      const user = createMockUser({ userPrincipalName: 'john.doe@example.com' });
      const result = mapper.toEntraProfile(user, 'FI');
      expect(result.userPrincipalName).toBe('john.doe@example.com');
    });

    it('should fall back to email when no UPN', () => {
      const user = createMockUser({ userPrincipalName: undefined });
      const result = mapper.toEntraProfile(user, 'FI');
      expect(result.userPrincipalName).toBe('john.doe@example.com');
    });

    it('should set accountEnabled=true for ACTIVE users', () => {
      const user = createMockUser({ status: UserStatus.ACTIVE });
      const result = mapper.toEntraProfile(user, 'FI');
      expect(result.accountEnabled).toBe(true);
    });

    it('should set accountEnabled=false for non-ACTIVE/PENDING users', () => {
      const user = createMockUser({ status: UserStatus.INACTIVE });
      const result = mapper.toEntraProfile(user, 'FI');
      expect(result.accountEnabled).toBe(false);
    });

    // A linked admin account (PAM) stands disabled: only a privileged session enables it
    it('creates a linked admin account disabled unless its session is active', () => {
      const admin = (status: UserStatus) =>
        createMockUser({
          status,
          employmentType: EmploymentType.ADMIN_ACCOUNT,
          sourceSystem: PAM_SOURCE_SYSTEM,
        });
      expect(mapper.toEntraProfile(admin(UserStatus.PENDING), 'FI').accountEnabled).toBe(false);
      expect(mapper.toEntraProfile(admin(UserStatus.INACTIVE), 'FI').accountEnabled).toBe(false);
      expect(mapper.toEntraProfile(admin(UserStatus.ACTIVE), 'FI').accountEnabled).toBe(true);
      // A regular joiner (PENDING) and an ADMIN_ACCOUNT identity that is no linked admin keep theirs
      expect(
        mapper.toEntraProfile(createMockUser({ status: UserStatus.PENDING }), 'FI').accountEnabled,
      ).toBe(true);
      const platformAdmin = createMockUser({
        status: UserStatus.PENDING,
        employmentType: EmploymentType.ADMIN_ACCOUNT,
      });
      expect(mapper.toEntraProfile(platformAdmin, 'FI').accountEnabled).toBe(true);
    });

    it('should include passwordProfile when password is provided', () => {
      const user = createMockUser();
      const result = mapper.toEntraProfile(user, 'FI', undefined, 'SecureP@ssw0rd123!');
      expect(result.passwordProfile).toBeDefined();
      expect(result.passwordProfile!.forceChangePasswordNextSignIn).toBe(true);
      expect(result.passwordProfile!.password).toBe('SecureP@ssw0rd123!');
    });

    it('should NOT include passwordProfile when no password is provided', () => {
      const user = createMockUser();
      const result = mapper.toEntraProfile(user, 'FI');
      expect(result.passwordProfile).toBeUndefined();
    });

    it('should strip undefined fields from result', () => {
      const user = createMockUser({ mobilePhone: undefined, postalCode: undefined });
      const result = mapper.toEntraProfile(user, 'FI');
      expect(Object.keys(result)).not.toContain('mobilePhone');
      expect(Object.keys(result)).not.toContain('postalCode');
    });

    it('should use defaultUsageLocation as fallback when no countryCode', () => {
      const user = createMockUser({ countryCode: undefined });
      const result = mapper.toEntraProfile(user, 'SE');
      expect(result.usageLocation).toBe('SE');
    });

    it('should build displayName from firstName + lastName when displayName missing', () => {
      const user = createMockUser({ displayName: undefined, firstName: 'Jane', lastName: 'Smith' });
      const result = mapper.toEntraProfile(user, 'FI');
      expect(result.displayName).toBe('Jane Smith');
    });
  });

  describe('toEntraUpdatePayload', () => {
    it('should map standard fields to Entra field names', () => {
      const user = createMockUser({
        firstName: 'Jane',
        lastName: 'Smith',
        displayName: 'Jane Smith',
        jobTitle: 'Manager',
        employeeId: 'EMP-001',
        city: 'Helsinki',
      });
      const result = mapper.toEntraUpdatePayload(user);

      expect(result.givenName).toBe('Jane');
      expect(result.surname).toBe('Smith');
      expect(result.displayName).toBe('Jane Smith');
      expect(result.jobTitle).toBe('Manager');
      expect(result.employeeId).toBe('EMP-001');
      expect(result.city).toBe('Helsinki');
    });

    it('should map status to accountEnabled', () => {
      const activeUser = createMockUser({ status: UserStatus.ACTIVE });
      expect(mapper.toEntraUpdatePayload(activeUser).accountEnabled).toBe(true);

      const pendingUser = createMockUser({ status: UserStatus.PENDING });
      expect(mapper.toEntraUpdatePayload(pendingUser).accountEnabled).toBe(true);

      const inactiveUser = createMockUser({ status: UserStatus.INACTIVE });
      expect(mapper.toEntraUpdatePayload(inactiveUser).accountEnabled).toBe(false);
    });

    it('keeps a linked admin account disabled on update unless its session is active', () => {
      const admin = (status: UserStatus) =>
        createMockUser({
          status,
          employmentType: EmploymentType.ADMIN_ACCOUNT,
          sourceSystem: PAM_SOURCE_SYSTEM,
        });
      expect(mapper.toEntraUpdatePayload(admin(UserStatus.PENDING)).accountEnabled).toBe(false);
      expect(mapper.toEntraUpdatePayload(admin(UserStatus.INACTIVE)).accountEnabled).toBe(false);
      expect(mapper.toEntraUpdatePayload(admin(UserStatus.ACTIVE)).accountEnabled).toBe(true);
    });

    it('should map countryCode to both country and usageLocation', () => {
      const user = createMockUser({ countryCode: 'FI' });
      const result = mapper.toEntraUpdatePayload(user);
      expect(result.country).toBe('FI');
      expect(result.usageLocation).toBe('FI');
    });

    it('should map departmentName to department', () => {
      const user = createMockUser({ departmentName: 'Engineering', departmentCode: undefined });
      const result = mapper.toEntraUpdatePayload(user);
      expect(result.department).toBe('Engineering');
    });

    it('should map workPhone to businessPhones array', () => {
      const user = createMockUser({ workPhone: '+358401234567' });
      const result = mapper.toEntraUpdatePayload(user);
      expect(result.businessPhones).toEqual(['+358401234567']);
    });

    it('should skip undefined and null fields', () => {
      const user = createMockUser({
        mobilePhone: undefined,
        postalCode: undefined,
        city: undefined,
      });
      const result = mapper.toEntraUpdatePayload(user);
      expect(result).not.toHaveProperty('mobilePhone');
      expect(result).not.toHaveProperty('postalCode');
      expect(result).not.toHaveProperty('city');
    });

    it('should skip empty jobTitle (nonEmpty guard)', () => {
      const user = createMockUser({ jobTitle: '' });
      const result = mapper.toEntraUpdatePayload(user);
      expect(result).not.toHaveProperty('jobTitle');
    });

    it('should return empty object when no updatable fields', () => {
      const user = createMockUser({
        firstName: undefined,
        lastName: undefined,
        displayName: undefined,
        jobTitle: undefined,
        employeeId: undefined,
        division: undefined,
        mobilePhone: undefined,
        workPhone: undefined,
        city: undefined,
        stateProvince: undefined,
        postalCode: undefined,
        departmentName: undefined,
        departmentCode: undefined,
        officeName: undefined,
        officeLocation: undefined,
        location: undefined,
        countryCode: undefined,
        status: undefined,
      });
      const result = mapper.toEntraUpdatePayload(user);
      expect(Object.keys(result).length).toBe(0);
    });
  });

  describe('extractWritebackAttributes', () => {
    it('should extract mail and objectId from provisioning result', () => {
      const result = extractWritebackAttributes({
        targetUserId: 'user-id-123',
        generatedAttributes: { mail: 'john@contoso.com', userPrincipalName: 'john@contoso.com' },
      });
      expect(result.email).toBe('john@contoso.com');
      expect(result.userPrincipalName).toBe('john@contoso.com');
      expect(result.objectId).toBe('user-id-123');
    });

    it('should return empty payload when no generated attributes', () => {
      const result = extractWritebackAttributes({ targetUserId: 'user-id-123' });
      expect(result.objectId).toBe('user-id-123');
      expect(result).not.toHaveProperty('email');
    });
  });
});
