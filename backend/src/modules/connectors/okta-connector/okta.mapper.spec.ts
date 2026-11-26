import { OktaMapper } from './okta.mapper';
import { createMockUser } from '@testing';
import { UserStatus, StandardUserDto } from '@shared/dtos/standard-user.dto';

describe('OktaMapper', () => {
  let mapper: OktaMapper;

  beforeEach(() => {
    mapper = new OktaMapper();
  });

  // ── toOktaProfile ──────────────────────────────────────────────────

  describe('toOktaProfile', () => {
    it('should map core fields (firstName, lastName, email, login)', () => {
      const user = createMockUser();
      const result = mapper.toOktaProfile(user);

      expect(result.firstName).toBe('John');
      expect(result.lastName).toBe('Doe');
      expect(result.email).toBe('john.doe@example.com');
      expect(result.login).toBe('john.doe@example.com'); // login = email
    });

    it('should map displayName when present', () => {
      const user = createMockUser({ displayName: 'Johnny D' });
      const result = mapper.toOktaProfile(user);
      expect(result.displayName).toBe('Johnny D');
    });

    it('should map mobilePhone when present', () => {
      const user = createMockUser({ mobilePhone: '+358401234567' });
      const result = mapper.toOktaProfile(user);
      expect(result.mobilePhone).toBe('+358401234567');
    });

    it('should map jobTitle to Okta title field', () => {
      const user = createMockUser({ jobTitle: 'Senior Engineer' });
      const result = mapper.toOktaProfile(user);
      expect(result.title).toBe('Senior Engineer');
    });

    it('should map departmentName to department', () => {
      const user = createMockUser({ departmentName: 'Engineering', departmentCode: undefined });
      const result = mapper.toOktaProfile(user);
      expect(result.department).toBe('Engineering');
    });

    it('should prefer departmentName over departmentCode', () => {
      const user = createMockUser({ departmentName: 'Engineering', departmentCode: 'ENG' });
      const result = mapper.toOktaProfile(user);
      expect(result.department).toBe('Engineering');
    });

    it('should fall back to departmentCode when departmentName is missing', () => {
      const user = createMockUser({ departmentName: undefined, departmentCode: 'ENG' });
      const result = mapper.toOktaProfile(user);
      expect(result.department).toBe('ENG');
    });

    it('should map employeeId to employeeNumber', () => {
      const user = createMockUser({ employeeId: 'EMP-999' });
      const result = mapper.toOktaProfile(user);
      expect(result.employeeNumber).toBe('EMP-999');
    });

    it('should map location fields (city, stateProvince, countryCode, postalCode)', () => {
      const user = createMockUser({
        city: 'Helsinki',
        stateProvince: 'Uusimaa',
        countryCode: 'FI',
        postalCode: '00100',
      });
      const result = mapper.toOktaProfile(user);

      expect(result.city).toBe('Helsinki');
      expect(result.state).toBe('Uusimaa');
      expect(result.countryCode).toBe('FI');
      expect(result.zipCode).toBe('00100');
    });

    it('should map managerEmail to manager field', () => {
      const user = createMockUser({ managerEmail: 'boss@example.com' });
      const result = mapper.toOktaProfile(user);
      expect(result.manager).toBe('boss@example.com');
    });

    it('should map costCenter', () => {
      const user = createMockUser({ costCenter: 'CC-100' });
      const result = mapper.toOktaProfile(user);
      expect(result.costCenter).toBe('CC-100');
    });

    it('should map officeName to streetAddress', () => {
      const user = createMockUser({ officeName: 'HQ Building', officeLocation: undefined, location: undefined });
      const result = mapper.toOktaProfile(user);
      expect(result.streetAddress).toBe('HQ Building');
    });

    it('should strip undefined and null fields from output', () => {
      const user = createMockUser({
        displayName: undefined,
        mobilePhone: undefined,
        jobTitle: undefined,
        division: undefined,
      });
      const result = mapper.toOktaProfile(user);

      expect(result).not.toHaveProperty('displayName');
      expect(result).not.toHaveProperty('mobilePhone');
      expect(result).not.toHaveProperty('title');
      expect(result).not.toHaveProperty('division');
    });

    it('should always include core fields even with minimal input', () => {
      const user = createMockUser({
        displayName: undefined,
        mobilePhone: undefined,
        jobTitle: undefined,
        departmentName: undefined,
        departmentCode: undefined,
        employeeId: undefined,
        division: undefined,
        city: undefined,
        stateProvince: undefined,
        countryCode: undefined,
        postalCode: undefined,
        officeName: undefined,
        officeLocation: undefined,
        location: undefined,
        managerEmail: undefined,
        costCenter: undefined,
      });
      const result = mapper.toOktaProfile(user);

      // Core fields always present
      expect(result.firstName).toBe('John');
      expect(result.lastName).toBe('Doe');
      expect(result.email).toBe('john.doe@example.com');
      expect(result.login).toBe('john.doe@example.com');
    });
  });

  // ── fromOktaUser ───────────────────────────────────────────────────

  describe('fromOktaUser', () => {
    it('should map all Okta profile fields to StandardUserDto', () => {
      const oktaUser = {
        id: 'okta-123',
        status: 'ACTIVE',
        profile: {
          firstName: 'Jane',
          lastName: 'Smith',
          email: 'jane@example.com',
          login: 'jane@example.com',
          displayName: 'Jane Smith',
          mobilePhone: '+358401111111',
          title: 'CTO',
          department: 'Executive',
          employeeNumber: 'EMP-002',
        },
      };
      const result = mapper.fromOktaUser(oktaUser);

      expect(result.firstName).toBe('Jane');
      expect(result.lastName).toBe('Smith');
      expect(result.email).toBe('jane@example.com');
      expect(result.displayName).toBe('Jane Smith');
      expect(result.mobilePhone).toBe('+358401111111');
      expect(result.jobTitle).toBe('CTO');
      expect(result.departmentName).toBe('Executive');
      expect(result.employeeId).toBe('EMP-002');
    });

    it('should handle missing optional Okta profile fields', () => {
      const oktaUser = {
        id: 'okta-456',
        status: 'STAGED',
        profile: {
          firstName: 'Bob',
          lastName: 'Jones',
          email: 'bob@example.com',
          login: 'bob@example.com',
        },
      };
      const result = mapper.fromOktaUser(oktaUser);

      expect(result.firstName).toBe('Bob');
      expect(result.lastName).toBe('Jones');
      expect(result.email).toBe('bob@example.com');
      expect(result.displayName).toBeUndefined();
      expect(result.mobilePhone).toBeUndefined();
      expect(result.jobTitle).toBeUndefined();
      expect(result.departmentName).toBeUndefined();
      expect(result.employeeId).toBeUndefined();
    });

    it('should return a partial StandardUserDto (not full)', () => {
      const oktaUser = {
        id: 'okta-789',
        status: 'ACTIVE',
        profile: {
          firstName: 'Test',
          lastName: 'User',
          email: 'test@example.com',
          login: 'test@example.com',
        },
      };
      const result = mapper.fromOktaUser(oktaUser);

      // Should not contain fields that Okta profile doesn't have
      expect(result).not.toHaveProperty('status');
      expect(result).not.toHaveProperty('sourceSystem');
      expect(result).not.toHaveProperty('tenantId');
    });
  });

  // ── toOktaUpdatePayload ────────────────────────────────────────────

  describe('toOktaUpdatePayload', () => {
    it('should produce the same output as toOktaProfile', () => {
      const user = createMockUser();
      const profile = mapper.toOktaProfile(user);
      const updatePayload = mapper.toOktaUpdatePayload(user);

      expect(updatePayload).toEqual(profile);
    });

    it('should include only non-null/non-undefined fields', () => {
      const user = createMockUser({ displayName: undefined, mobilePhone: undefined });
      const result = mapper.toOktaUpdatePayload(user);

      expect(result).not.toHaveProperty('displayName');
      expect(result).not.toHaveProperty('mobilePhone');
      expect(result.firstName).toBe('John');
    });
  });
});
