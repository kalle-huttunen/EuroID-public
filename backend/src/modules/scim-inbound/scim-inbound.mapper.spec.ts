import { Test, TestingModule } from '@nestjs/testing';
import { ScimInboundMapper } from './scim-inbound.mapper';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { SCIMError } from '@shared/scim';

describe('ScimInboundMapper', () => {
  let mapper: ScimInboundMapper;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ScimInboundMapper],
    }).compile();
    mapper = module.get<ScimInboundMapper>(ScimInboundMapper);
  });

  describe('toStandardUser (inbound)', () => {
    it('should map SCIMUser to StandardUserDto fields', () => {
      const scimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'john@example.com',
        name: { givenName: 'John', familyName: 'Doe' },
        displayName: 'John Doe',
        emails: [{ value: 'john@example.com', type: 'work', primary: true }],
        active: true,
        title: 'Engineer',
        externalId: 'EMP-001',
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
          department: 'Engineering',
          employeeNumber: 'EMP-001',
          organization: 'Acme Corp',
          manager: { displayName: 'jane@example.com' },
        },
      };

      const dto = mapper.toStandardUser(scimUser);
      expect(dto.email).toBe('john@example.com');
      expect(dto.firstName).toBe('John');
      expect(dto.lastName).toBe('Doe');
      expect(dto.displayName).toBe('John Doe');
      expect(dto.jobTitle).toBe('Engineer');
      expect(dto.departmentName).toBe('Engineering');
      expect(dto.employeeId).toBe('EMP-001');
      expect(dto.managerEmail).toBe('jane@example.com');
      expect(dto.status).toBe(UserStatus.ACTIVE);
      expect(dto.sourceUserId).toBe('EMP-001');
      expect(dto.customAttributes?.company).toBe('Acme Corp');
    });

    it('should map active false to status inactive', () => {
      const scimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'inactive@example.com',
        name: { givenName: 'Inactive', familyName: 'User' },
        emails: [{ value: 'inactive@example.com', primary: true }],
        active: false,
      };

      const dto = mapper.toStandardUser(scimUser);
      expect(dto.status).toBe(UserStatus.INACTIVE);
    });

    it('should handle missing name object', () => {
      const scimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'minimal@example.com',
        emails: [{ value: 'minimal@example.com', primary: true }],
        active: true,
      };

      const dto = mapper.toStandardUser(scimUser);
      expect(dto.email).toBe('minimal@example.com');
      expect(dto.firstName).toBe('');
      expect(dto.lastName).toBe('');
    });

    it('should handle empty emails array', () => {
      const scimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'nochemail@example.com',
        emails: [],
        active: true,
      };

      const dto = mapper.toStandardUser(scimUser);
      expect(dto.email).toBe('nochemail@example.com');
    });

    it('should map phone numbers', () => {
      const scimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'phone@example.com',
        name: { givenName: 'Phone', familyName: 'User' },
        emails: [{ value: 'phone@example.com', primary: true }],
        phoneNumbers: [
          { value: '+1234567890', type: 'work' },
          { value: '+0987654321', type: 'mobile' },
        ],
        active: true,
      };

      const dto = mapper.toStandardUser(scimUser);
      expect(dto.workPhone).toBe('+1234567890');
      expect(dto.mobilePhone).toBe('+0987654321');
    });
  });

  describe('toSCIMResponse (outbound)', () => {
    it('should map identity/user record to SCIMUser', () => {
      const user = {
        _id: '507f1f77bcf86cd799439011',
        email: 'john@example.com',
        firstName: 'John',
        lastName: 'Doe',
        displayName: 'John Doe',
        jobTitle: 'Engineer',
        departmentName: 'Engineering',
        status: UserStatus.ACTIVE,
        employeeId: 'EMP-001',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-15'),
      };

      const scim = mapper.toSCIMResponse(user, 'https://api.example.com');
      expect(scim.id).toBe('507f1f77bcf86cd799439011');
      expect(scim.userName).toBe('john@example.com');
      expect(scim.name?.givenName).toBe('John');
      expect(scim.name?.familyName).toBe('Doe');
      expect(scim.displayName).toBe('John Doe');
      expect(scim.title).toBe('Engineer');
      expect(scim.active).toBe(true);
      expect(scim.emails).toEqual([{ value: 'john@example.com', type: 'work', primary: true }]);
      expect(scim.meta?.resourceType).toBe('User');
      expect(scim.meta?.location).toContain('/scim/v2/Users/507f1f77bcf86cd799439011');
    });

    it('should include enterprise extension when present', () => {
      const user = {
        _id: 'id-1',
        email: 'j@ex.com',
        firstName: 'J',
        lastName: 'D',
        departmentName: 'Sales',
        employeeId: 'E1',
        managerEmail: 'boss@ex.com',
      };

      const scim = mapper.toSCIMResponse(user, 'https://api.example.com');
      const enterprise = scim['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'];
      expect(enterprise?.department).toBe('Sales');
      expect(enterprise?.employeeNumber).toBe('E1');
      expect(enterprise?.manager?.displayName).toBe('boss@ex.com');
    });

    it('should map inactive status to active false', () => {
      const user = {
        _id: 'id-1',
        email: 'inactive@ex.com',
        firstName: 'In',
        lastName: 'Active',
        status: UserStatus.INACTIVE,
      };

      const scim = mapper.toSCIMResponse(user, 'https://api.example.com');
      expect(scim.active).toBe(false);
    });
  });

  describe('roundtrip', () => {
    it('should preserve key fields through dto → SCIMUser → dto', () => {
      const originalDto = {
        firstName: 'Jane',
        lastName: 'Smith',
        email: 'jane@example.com',
        displayName: 'Jane Smith',
        jobTitle: 'Manager',
        departmentName: 'HR',
        employeeId: 'E002',
        status: UserStatus.ACTIVE,
      };

      const scimUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: originalDto.email,
        name: { givenName: originalDto.firstName, familyName: originalDto.lastName },
        displayName: originalDto.displayName,
        emails: [{ value: originalDto.email, type: 'work', primary: true }],
        title: originalDto.jobTitle,
        active: true,
        externalId: originalDto.employeeId,
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
          department: originalDto.departmentName,
          employeeNumber: originalDto.employeeId,
        },
      };

      const backToDto = mapper.toStandardUser(scimUser);
      expect(backToDto.firstName).toBe(originalDto.firstName);
      expect(backToDto.lastName).toBe(originalDto.lastName);
      expect(backToDto.email).toBe(originalDto.email);
      expect(backToDto.displayName).toBe(originalDto.displayName);
      expect(backToDto.jobTitle).toBe(originalDto.jobTitle);
      expect(backToDto.departmentName).toBe(originalDto.departmentName);
      expect(backToDto.employeeId).toBe(originalDto.employeeId);
      expect(backToDto.status).toBe(originalDto.status);
    });
  });

  describe('toEntitlementEntry (group)', () => {
    it('should map SCIMGroup to entitlement catalog entry', () => {
      const scimGroup = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Engineering',
        externalId: 'eng-001',
        members: [
          { value: 'user-1', type: 'User' },
          { value: 'user-2', type: 'User' },
        ],
      };

      const entry = mapper.toEntitlementEntry(scimGroup);

      expect(entry.name).toBe('Engineering');
      expect(entry.system).toBe('scim-inbound');
      expect(entry.type).toBe('Group');
      expect(entry.metadata?.scimMembers).toEqual(['user-1', 'user-2']);
      expect((entry.metadata as Record<string, unknown>)?.externalId).toBe('eng-001');
    });

    it('keeps the type of each member sent with one, User or Group in any case', () => {
      const entry = mapper.toEntitlementEntry({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Engineering',
        members: [
          { value: 'user-1', type: 'User' },
          { value: 'group-1', type: 'Group' },
          { value: 'group-2', type: 'group' },
          { value: 'user-2' },
          { value: 'device-1', type: 'Device' },
        ],
      });

      expect(entry.metadata?.scimMembers).toEqual([
        'user-1',
        'group-1',
        'group-2',
        'user-2',
        'device-1',
      ]);
      expect(entry.metadata?.scimMemberTypes).toEqual([
        { value: 'user-1', type: 'User' },
        { value: 'group-1', type: 'Group' },
        { value: 'group-2', type: 'Group' },
      ]);
    });

    it('should handle group without members or externalId', () => {
      const scimGroup = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Empty Group',
      };

      const entry = mapper.toEntitlementEntry(scimGroup);

      expect(entry.name).toBe('Empty Group');
      expect(entry.metadata?.scimMembers).toEqual([]);
      expect((entry.metadata as Record<string, unknown>)?.externalId).toBeUndefined();
    });
  });

  describe('applyPatchOps', () => {
    it('should apply valid replace operations', () => {
      const current = {
        email: 'old@example.com',
        firstName: 'Old',
        lastName: 'Name',
        displayName: 'Old Name',
        status: UserStatus.ACTIVE,
      };
      const ops = [
        { op: 'replace' as const, path: 'displayName', value: 'New Name' },
        { op: 'replace' as const, path: 'name.givenName', value: 'New' },
      ];
      const result = mapper.applyPatchOps(current, ops);
      expect(result.displayName).toBe('New Name');
      expect(result.firstName).toBe('New');
    });

    // Hunt 2026-11-25 (02 F13): the result was the whole projected record (metadata included),
    // so every PATCH wrote and reported every field as changed, and `remove` deleted the field
    // from that copy only, changing nothing
    it('answers only the fields the operations change', () => {
      const current = {
        _id: 'id-1',
        email: 'old@example.com',
        displayName: 'Old Name',
        metadata: { mastery: {} },
      };
      const ops = [{ op: 'replace' as const, path: 'displayName', value: 'New Name' }];

      expect(mapper.applyPatchOps(current, ops)).toEqual({ displayName: 'New Name' });
    });

    it('clears an optional attribute on remove', () => {
      const current = { email: 'a@example.com', jobTitle: 'Engineer', departmentName: 'R&D' };
      const ops = [
        { op: 'remove' as const, path: 'title' },
        {
          op: 'remove' as const,
          path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department',
        },
      ];

      expect(mapper.applyPatchOps(current, ops)).toEqual({ jobTitle: null, departmentName: null });
    });

    it.each(['userName', 'emails', 'name.givenName', 'name.familyName', 'active'])(
      'refuses to remove the required %s (400 mutability)',
      (path) => {
        expect(() => mapper.applyPatchOps({}, [{ op: 'remove' as const, path }])).toThrow(
          expect.objectContaining({ scimStatus: '400', scimType: 'mutability' }),
        );
      },
    );

    it('takes the primary email of an add on emails, as a replace does', () => {
      const ops = [
        {
          op: 'add' as const,
          path: 'emails',
          value: [{ value: 'new@example.com', primary: true }],
        },
      ];

      expect(mapper.applyPatchOps({}, ops)).toEqual({ email: 'new@example.com' });
    });

    it('should reject unsupported path with SCIMError', () => {
      const current = { email: 'test@example.com' };
      const ops = [{ op: 'replace' as const, path: 'tenantId', value: 'evil-tenant' }];
      expect(() => mapper.applyPatchOps(current, ops)).toThrow(SCIMError);
    });

    it('should reject empty path with SCIMError', () => {
      const current = { email: 'test@example.com' };
      const ops = [{ op: 'replace' as const, path: '', value: 'x' }];
      expect(() => mapper.applyPatchOps(current, ops)).toThrow(SCIMError);
    });
  });

  describe('toSCIMGroupResponse', () => {
    it('should map entitlement catalog entry to SCIMGroup', () => {
      const entry = {
        _id: { toString: () => 'grp-123' },
        name: 'Sales',
        metadata: {
          scimMembers: ['user-a', 'user-b'],
          externalId: 'sales-001',
        },
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-15'),
      };

      const scim = mapper.toSCIMGroupResponse(entry, 'https://api.example.com');

      expect(scim.id).toBe('grp-123');
      expect(scim.displayName).toBe('Sales');
      expect(scim.externalId).toBe('sales-001');
      expect(scim.members).toHaveLength(2);
      expect(scim.members?.[0].value).toBe('user-a');
      expect(scim.members?.[0].$ref).toContain('/scim/v2/Users/user-a');
      expect(scim.meta?.resourceType).toBe('Group');
      expect(scim.meta?.location).toContain('/scim/v2/Groups/grp-123');
    });

    it('returns a member stored as a Group with its Groups $ref, the others as users', () => {
      const scim = mapper.toSCIMGroupResponse(
        {
          _id: { toString: () => 'grp-123' },
          name: 'Sales',
          metadata: {
            scimMembers: ['user-a', 'grp-nested'],
            scimMemberTypes: [{ value: 'grp-nested', type: 'Group' }],
          },
        },
        'https://api.example.com/',
      );

      expect(scim.members).toEqual([
        {
          value: 'user-a',
          type: 'User',
          $ref: 'https://api.example.com/scim/v2/Users/user-a',
        },
        {
          value: 'grp-nested',
          type: 'Group',
          $ref: 'https://api.example.com/scim/v2/Groups/grp-nested',
        },
      ]);
    });
  });
});
