import { SCIMMapper } from './scim.mapper';
import { createMockUser } from '@testing';
import { EmploymentType, UserStatus } from '@shared/dtos/standard-user.dto';
import { PAM_SOURCE_SYSTEM } from '@shared/utils/linked-admin-profile';
import { SCIM_SCHEMAS } from '@shared/scim';

describe('SCIMMapper', () => {
  let mapper: SCIMMapper;

  beforeEach(() => {
    mapper = new SCIMMapper();
  });

  // ───────── toSCIMUser ─────────

  describe('toSCIMUser', () => {
    it('should map all standard fields correctly', () => {
      const user = createMockUser();
      const scim = mapper.toSCIMUser(user);

      expect(scim.schemas).toContain(SCIM_SCHEMAS.USER);
      expect(scim.userName).toBe('john.doe@example.com');
      expect(scim.name?.givenName).toBe('John');
      expect(scim.name?.familyName).toBe('Doe');
      expect(scim.displayName).toBe('John Doe');
      expect(scim.active).toBe(true);
      expect(scim.title).toBe('Software Engineer');
    });

    it('should map email as primary work email', () => {
      const user = createMockUser();
      const scim = mapper.toSCIMUser(user);

      expect(scim.emails).toHaveLength(1);
      expect(scim.emails![0].value).toBe('john.doe@example.com');
      expect(scim.emails![0].type).toBe('work');
      expect(scim.emails![0].primary).toBe(true);
    });

    it('should map enterprise extension fields', () => {
      const user = createMockUser({
        employeeId: 'EMP-001',
        departmentName: 'Engineering',
        division: 'Product',
        managerEmail: 'manager@example.com',
      });
      const scim = mapper.toSCIMUser(user);

      expect(scim.schemas).toContain(SCIM_SCHEMAS.ENTERPRISE_USER);
      const enterprise = scim['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'];
      expect(enterprise).toBeDefined();
      expect(enterprise!.employeeNumber).toBe('EMP-001');
      expect(enterprise!.department).toBe('Engineering');
      expect(enterprise!.division).toBe('Product');
      expect(enterprise!.manager?.displayName).toBe('manager@example.com');
    });

    it('should set externalId from employeeId or sourceUserId', () => {
      const userWithEmpId = createMockUser({ employeeId: 'EMP-999' });
      expect(mapper.toSCIMUser(userWithEmpId).externalId).toBe('EMP-999');

      const userNoEmpId = createMockUser({ employeeId: undefined });
      expect(mapper.toSCIMUser(userNoEmpId).externalId).toBe('EMP-001'); // sourceUserId
    });

    it('should fall back to email when no userPrincipalName', () => {
      const user = createMockUser({ userPrincipalName: undefined });
      const scim = mapper.toSCIMUser(user);
      expect(scim.userName).toBe('john.doe@example.com');
    });

    it('should set active=true for ACTIVE users', () => {
      const user = createMockUser({ status: UserStatus.ACTIVE });
      expect(mapper.toSCIMUser(user).active).toBe(true);
    });

    it('should set active=true for PENDING users', () => {
      const user = createMockUser({ status: UserStatus.PENDING });
      expect(mapper.toSCIMUser(user).active).toBe(true);
    });

    it('should set active=false for INACTIVE users', () => {
      const user = createMockUser({ status: UserStatus.INACTIVE });
      expect(mapper.toSCIMUser(user).active).toBe(false);
    });

    it('should set active=false for TERMINATED users', () => {
      const user = createMockUser({ status: UserStatus.TERMINATED });
      expect(mapper.toSCIMUser(user).active).toBe(false);
    });

    it('creates a linked admin account inactive unless its session is active', () => {
      const admin = (status: UserStatus) =>
        createMockUser({
          status,
          employmentType: EmploymentType.ADMIN_ACCOUNT,
          sourceSystem: PAM_SOURCE_SYSTEM,
        });
      expect(mapper.toSCIMUser(admin(UserStatus.PENDING)).active).toBe(false);
      expect(mapper.toSCIMUser(admin(UserStatus.INACTIVE)).active).toBe(false);
      expect(mapper.toSCIMUser(admin(UserStatus.ACTIVE)).active).toBe(true);
    });

    it('should build formatted name from displayName', () => {
      const user = createMockUser({ displayName: 'Johnny D' });
      const scim = mapper.toSCIMUser(user);
      expect(scim.name?.formatted).toBe('Johnny D');
    });

    it('should build formatted name from firstName + lastName when no displayName', () => {
      const user = createMockUser({ displayName: undefined });
      const scim = mapper.toSCIMUser(user);
      expect(scim.name?.formatted).toBe('John Doe');
    });

    it('should map phone numbers', () => {
      const user = createMockUser({ workPhone: '+1-555-1234', mobilePhone: '+1-555-5678' });
      const scim = mapper.toSCIMUser(user);

      expect(scim.phoneNumbers).toHaveLength(2);
      expect(scim.phoneNumbers![0]).toEqual({ value: '+1-555-1234', type: 'work' });
      expect(scim.phoneNumbers![1]).toEqual({ value: '+1-555-5678', type: 'mobile' });
    });

    it('should omit phoneNumbers when none provided', () => {
      const user = createMockUser({ workPhone: undefined, mobilePhone: undefined });
      const scim = mapper.toSCIMUser(user);
      // phoneNumbers should not be present (stripped)
      expect(scim.phoneNumbers).toBeUndefined();
    });

    it('should not include enterprise schema when no enterprise fields', () => {
      const user = createMockUser({
        employeeId: undefined,
        departmentName: undefined,
        departmentCode: undefined,
        division: undefined,
        managerEmail: undefined,
      });
      const scim = mapper.toSCIMUser(user);

      expect(scim.schemas).not.toContain(SCIM_SCHEMAS.ENTERPRISE_USER);
      expect(scim['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User']).toBeUndefined();
    });

    it('should use departmentCode when departmentName is absent', () => {
      const user = createMockUser({ departmentName: undefined, departmentCode: 'ENG' });
      const scim = mapper.toSCIMUser(user);
      const enterprise = scim['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'];
      expect(enterprise!.department).toBe('ENG');
    });
  });

  // ───────── fromSCIMUser ─────────

  describe('fromSCIMUser', () => {
    it('should map SCIM user back to StandardUserDto fields', () => {
      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER],
        userName: 'john.doe@example.com',
        name: { givenName: 'John', familyName: 'Doe', middleName: 'M' },
        displayName: 'John Doe',
        active: true,
        title: 'Software Engineer',
        emails: [{ value: 'john.doe@example.com', type: 'work', primary: true }],
      };

      const dto = mapper.fromSCIMUser(scimUser);

      expect(dto.firstName).toBe('John');
      expect(dto.lastName).toBe('Doe');
      expect(dto.middleName).toBe('M');
      expect(dto.displayName).toBe('John Doe');
      expect(dto.email).toBe('john.doe@example.com');
      expect(dto.userPrincipalName).toBe('john.doe@example.com');
      expect(dto.jobTitle).toBe('Software Engineer');
      expect(dto.status).toBe(UserStatus.ACTIVE);
    });

    it('should map enterprise extension fields', () => {
      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER, SCIM_SCHEMAS.ENTERPRISE_USER],
        userName: 'john@example.com',
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
          employeeNumber: 'EMP-001',
          department: 'Engineering',
          division: 'Product',
          manager: { displayName: 'manager@example.com' },
        },
      };

      const dto = mapper.fromSCIMUser(scimUser);

      expect(dto.employeeId).toBe('EMP-001');
      expect(dto.departmentName).toBe('Engineering');
      expect(dto.division).toBe('Product');
      expect(dto.managerEmail).toBe('manager@example.com');
    });

    it('should set INACTIVE status when active=false', () => {
      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER],
        userName: 'john@example.com',
        active: false,
      };

      const dto = mapper.fromSCIMUser(scimUser);
      expect(dto.status).toBe(UserStatus.INACTIVE);
    });

    it('should use first email when no primary email', () => {
      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER],
        userName: 'john@example.com',
        emails: [
          { value: 'john@personal.com', type: 'home' },
          { value: 'john@work.com', type: 'work' },
        ],
      };

      const dto = mapper.fromSCIMUser(scimUser);
      expect(dto.email).toBe('john@personal.com');
    });

    it('should handle missing optional fields gracefully', () => {
      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER],
        userName: 'minimal@example.com',
      };

      const dto = mapper.fromSCIMUser(scimUser);
      expect(dto.userPrincipalName).toBe('minimal@example.com');
      expect(dto.firstName).toBeUndefined();
      expect(dto.lastName).toBeUndefined();
      expect(dto.email).toBeUndefined();
    });

    it('should handle empty emails array', () => {
      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER],
        userName: 'john@example.com',
        emails: [],
      };

      const dto = mapper.fromSCIMUser(scimUser);
      expect(dto.email).toBeUndefined();
    });

    it('should map phone numbers from SCIM to DTO', () => {
      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER],
        userName: 'john@example.com',
        phoneNumbers: [
          { value: '+1-555-1234', type: 'work' },
          { value: '+1-555-5678', type: 'mobile' },
        ],
      };

      const dto = mapper.fromSCIMUser(scimUser);
      expect(dto.workPhone).toBe('+1-555-1234');
      expect(dto.mobilePhone).toBe('+1-555-5678');
    });
  });

  // ───────── Roundtrip ─────────

  describe('roundtrip (dto → SCIMUser → dto)', () => {
    it('should preserve key fields through roundtrip', () => {
      const original = createMockUser({
        firstName: 'Alice',
        lastName: 'Smith',
        email: 'alice.smith@example.com',
        jobTitle: 'Product Manager',
        departmentName: 'Product',
        division: 'Core',
        employeeId: 'EMP-123',
        status: UserStatus.ACTIVE,
        workPhone: '+358-40-1234567',
        mobilePhone: '+358-50-9876543',
      });

      const scimUser = mapper.toSCIMUser(original);
      const roundtripped = mapper.fromSCIMUser(scimUser);

      expect(roundtripped.firstName).toBe(original.firstName);
      expect(roundtripped.lastName).toBe(original.lastName);
      expect(roundtripped.email).toBe(original.email);
      expect(roundtripped.jobTitle).toBe(original.jobTitle);
      expect(roundtripped.departmentName).toBe(original.departmentName);
      expect(roundtripped.division).toBe(original.division);
      expect(roundtripped.employeeId).toBe(original.employeeId);
      expect(roundtripped.status).toBe(UserStatus.ACTIVE);
      expect(roundtripped.workPhone).toBe(original.workPhone);
      expect(roundtripped.mobilePhone).toBe(original.mobilePhone);
    });
  });
});
