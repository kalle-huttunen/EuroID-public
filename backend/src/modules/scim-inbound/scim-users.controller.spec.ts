import { ZodError } from 'zod';
import { Test, TestingModule } from '@nestjs/testing';
import { ScimUsersController } from './scim-users.controller';
import { IdentityService } from '../identity/identity.service';
import { ScimInboundMapper } from './scim-inbound.mapper';
import { ScimFilterService } from './scim-filter.service';
import { ScimAuthGuard } from './guards/scim-auth.guard';
import { SCIM_SCHEMAS, SCIMError } from '@shared/scim';
import { HrMasteredFieldsException } from '../identity/hr-mastered-fields.exception';
import { IdentityLimitReached } from '../identity/identity-limit';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';

describe('ScimUsersController', () => {
  let controller: ScimUsersController;
  let identityService: jest.Mocked<IdentityService>;

  const mockUser = {
    _id: 'user-123',
    email: 'john@example.com',
    firstName: 'John',
    lastName: 'Doe',
    displayName: 'John Doe',
    status: 'ACTIVE',
    sourceSystem: 'SCIM-INBOUND',
    sourceUserId: 'john@example.com',
    tenantId: 'default',
    toObject: () => mockUser,
  };

  beforeEach(async () => {
    const mockIdentityService = {
      findByEmail: jest.fn(),
      create: jest.fn(),
      findAllPaginated: jest.fn(),
      findById: jest.fn(),
      saveOrUpdate: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScimUsersController],
      providers: [
        ScimInboundMapper,
        ScimFilterService,
        { provide: IdentityService, useValue: mockIdentityService },
      ],
    })
      .overrideGuard(ScimAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ScimUsersController>(ScimUsersController);
    identityService = module.get(IdentityService) as jest.Mocked<IdentityService>;

    jest.clearAllMocks();
  });

  // Hunt 2026-11-25 (r2-02 N7): meta.location was built from X-Forwarded-Host as sent
  it('builds meta.location without a forwarded host it did not trust', async () => {
    const savedBase = process.env.APP_BASE_URL;
    delete process.env.APP_BASE_URL;
    identityService.findById.mockResolvedValue(mockUser as never);
    const req = {
      protocol: 'https',
      get: () => 'euroid.acme.test',
      headers: { 'x-forwarded-host': 'evil.example' },
    };

    const user = await controller.getById('user-123', req as never);

    if (savedBase !== undefined) process.env.APP_BASE_URL = savedBase;
    expect(user.meta?.location).toBe('https://euroid.acme.test/scim/v2/Users/user-123');
  });

  describe('create (POST)', () => {
    it('should create user and return SCIMUser with id and meta', async () => {
      identityService.findAllPaginated.mockResolvedValue([[], 0]);
      identityService.create.mockResolvedValue(mockUser);

      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER],
        userName: 'john@example.com',
        name: { givenName: 'John', familyName: 'Doe' },
        emails: [{ value: 'john@example.com', primary: true }],
        active: true,
      };

      const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };
      const result = await withTenantContext('tenant-scim', () =>
        controller.create(scimUser, req as any),
      );

      expect(result).toHaveProperty('id', 'user-123');
      expect(result).toHaveProperty('meta');
      expect(result.meta?.resourceType).toBe('User');
      expect(result.meta?.location).toContain('/scim/v2/Users/user-123');
      expect(identityService.create).toHaveBeenCalled();
    });

    it("creates the identity in the SCIM token's tenant, not the mapper default", async () => {
      identityService.findAllPaginated.mockResolvedValue([[], 0]);
      identityService.create.mockResolvedValue(mockUser);
      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER],
        userName: 'john@example.com',
        name: { givenName: 'John', familyName: 'Doe' },
        active: true,
      };
      const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };

      await withTenantContext('tenant-scim', () =>
        controller.create(scimUser, req as unknown as Parameters<typeof controller.create>[1]),
      );

      expect(identityService.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-scim' }),
        'scim-inbound',
      );
    });

    // The tenant's identity limit: SCIM's error format, 409 naming the limit, and no scimType
    // (`uniqueness`, which SCIMErrorFilter gives any other 409, would send the IdP looking for a
    // duplicate that does not exist)
    it('answers the identity limit as a SCIM 409 naming it, without scimType uniqueness', async () => {
      identityService.findAllPaginated.mockResolvedValue([[], 0]);
      identityService.create.mockRejectedValue(new IdentityLimitReached(250));
      const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };

      const err = await Promise.resolve(
        withTenantContext('tenant-scim', () =>
          controller.create(
            { schemas: [SCIM_SCHEMAS.USER], userName: 'new@example.com', active: true },
            req as never,
          ),
        ),
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SCIMError);
      expect(err).toMatchObject({ scimStatus: '409', scimType: undefined });
      expect((err as SCIMError).detail).toMatch(/identity limit \(250\)/);
    });

    it('should return 409 when userName already exists', async () => {
      identityService.findAllPaginated.mockResolvedValue([[mockUser], 1]);

      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER],
        userName: 'john@example.com',
        name: { givenName: 'John', familyName: 'Doe' },
        emails: [{ value: 'john@example.com', primary: true }],
        active: true,
      };

      const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };
      await expect(controller.create(scimUser, req as any)).rejects.toThrow(
        /userName or email already exists/,
      );
      expect(identityService.create).not.toHaveBeenCalled();
    });
  });

  describe('list (GET)', () => {
    it('should return SCIMListResponse with pagination', async () => {
      identityService.findAllPaginated.mockResolvedValue([[mockUser], 1]);

      const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };
      const result = await controller.list(req as any, '1', '100', undefined);

      expect(result.schemas).toContain(SCIM_SCHEMAS.LIST_RESPONSE);
      expect(result.totalResults).toBe(1);
      expect(result.startIndex).toBe(1);
      expect(result.Resources).toHaveLength(1);
      expect(result.Resources[0]).toHaveProperty('id', 'user-123');
      expect(identityService.findAllPaginated).toHaveBeenCalledWith(0, 100, expect.anything());
    });

    // Package HX-B's follow-up: a count above 100 failed Zod and answered 500
    it('returns at most 100 resources for a larger count, as RFC 7644 allows', async () => {
      identityService.findAllPaginated.mockResolvedValue([[], 0]);

      const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };
      await controller.list(req as never, '1', '500', undefined);

      expect(identityService.findAllPaginated).toHaveBeenCalledWith(0, 100, expect.anything());
    });

    it('refuses a count that is no number with the error SCIMErrorFilter answers 400', async () => {
      const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };
      await expect(controller.list(req as never, '1', 'many', undefined)).rejects.toBeInstanceOf(
        ZodError,
      );
    });

    it('should convert startIndex 1-based to skip 0-based', async () => {
      identityService.findAllPaginated.mockResolvedValue([[], 0]);

      const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };
      await controller.list(req as any, '2', '50', undefined);

      expect(identityService.findAllPaginated).toHaveBeenCalledWith(1, 51, expect.anything());
    });
  });

  describe('getById (GET :id)', () => {
    it('should return SCIMUser for existing user', async () => {
      identityService.findById.mockResolvedValue(mockUser);

      const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };
      const result = await controller.getById('user-123', req as any);

      expect(result).toHaveProperty('id', 'user-123');
      expect(result).toHaveProperty('userName', 'john@example.com');
    });

    it('should throw when user not found', async () => {
      identityService.findById.mockResolvedValue(null);

      const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };
      await expect(controller.getById('unknown', req as any)).rejects.toThrow(/User not found/);
    });
  });

  describe('delete (DELETE :id)', () => {
    it('should soft-delete by setting status inactive', async () => {
      identityService.findById.mockResolvedValue(mockUser);
      identityService.update.mockResolvedValue({ ...mockUser, status: 'INACTIVE' });

      await controller.delete('user-123');

      expect(identityService.update).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({ status: 'INACTIVE' }),
        'scim-inbound',
        { refuseHrMastered: true },
      );
    });

    it('answers a status HR masters with the mutability error', async () => {
      identityService.findById.mockResolvedValue(mockUser);
      identityService.update.mockRejectedValue(refused('status', 'csv-hr'));

      await expect(controller.delete('user-123')).rejects.toMatchObject({
        scimType: 'mutability',
        scimStatus: '400',
      });
    });
  });

  /**
   * Owner decision 2026-11-24: a SCIM client may not change a field an HR source masters, since
   * the next HR sync would set it back and access would flap. SCIM's own error model answers it
   * (RFC 7644 §3.12: 400, scimType "mutability"); a full PUT that repeats the current value of
   * such a field passes, since the identity service refuses only a changed value.
   */
  describe('fields an HR source masters (PUT, PATCH)', () => {
    const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} };
    const put = {
      schemas: [SCIM_SCHEMAS.USER],
      userName: 'john@example.com',
      name: { givenName: 'Johnny', familyName: 'Doe' },
      emails: [{ value: 'john@example.com', primary: true }],
      active: true,
    };
    const patch = {
      schemas: [SCIM_SCHEMAS.PATCH_OP],
      Operations: [{ op: 'replace', path: 'name.givenName', value: 'Johnny' }],
    };

    beforeEach(() => {
      identityService.findById.mockResolvedValue(mockUser);
    });

    it.each([
      ['PUT', () => controller.replace('user-123', put, req as any)],
      ['PATCH', () => controller.patch('user-123', patch, req as any)],
    ])(
      '%s answers 400 mutability naming the field and its owner, and asks for the refusal',
      async (_m, call) => {
        identityService.update.mockRejectedValue(refused('firstName', 'csv-hr'));

        const error = await call().catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SCIMError);
        expect(error).toMatchObject({
          scimType: 'mutability',
          scimStatus: '400',
          detail: 'firstName is mastered by csv-hr: change it in HR.',
        });
        expect((error as SCIMError).getStatus()).toBe(400);
        expect(identityService.update).toHaveBeenCalledWith(
          'user-123',
          expect.objectContaining({ firstName: 'Johnny' }),
          'scim-inbound',
          { refuseHrMastered: true },
        );
      },
    );

    it('passes the update when the identity service accepts it (no mastered value changed)', async () => {
      identityService.update.mockResolvedValue({ ...mockUser });

      const result = await controller.replace('user-123', put, req as any);

      expect(result).toHaveProperty('id', 'user-123');
    });

    it('keeps other errors as they are', async () => {
      identityService.update.mockRejectedValue(new Error('MongoServerError: down'));

      await expect(controller.patch('user-123', patch, req as any)).rejects.toThrow(
        'MongoServerError: down',
      );
    });
  });

  /**
   * What an IdP sends: a PATCH that deactivates or reactivates the account (the common leaver
   * signal), a PUT that replaces the attributes, both on an id the identity hub holds. An unknown
   * id is 404 and a malformed body 400, in SCIM's error model, and nothing is written.
   */
  // Package HX-B's follow-up: emails[].value and a userName used as the email were stored
  // without a format check, and reached target connectors (the ServiceNow `^` case)
  describe('a malformed email (POST, PUT, PATCH)', () => {
    const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} } as never;
    const invalid = { scimType: 'invalidValue', scimStatus: '400' };

    it('refuses a create whose primary email or userName-as-email is no email', async () => {
      identityService.findAllPaginated.mockResolvedValue([[], 0]);

      await expect(
        controller.create(
          {
            schemas: [SCIM_SCHEMAS.USER],
            userName: 'jdoe',
            emails: [{ value: 'j^doe@x', primary: true }],
            name: { givenName: 'J', familyName: 'Doe' },
          },
          req,
        ),
      ).rejects.toMatchObject(invalid);
      await expect(
        controller.create(
          { schemas: [SCIM_SCHEMAS.USER], userName: 'not an email', name: { givenName: 'J' } },
          req,
        ),
      ).rejects.toMatchObject(invalid);
      expect(identityService.create).not.toHaveBeenCalled();
    });

    it('refuses a PUT or PATCH that sets an email that is no email', async () => {
      identityService.findById.mockResolvedValue(mockUser as never);

      await expect(
        controller.replace(
          'user-123',
          {
            schemas: [SCIM_SCHEMAS.USER],
            userName: 'john@example.com',
            emails: [{ value: 'john@@example', primary: true }],
          },
          req,
        ),
      ).rejects.toMatchObject(invalid);
      await expect(
        controller.patch(
          'user-123',
          {
            schemas: [SCIM_SCHEMAS.PATCH_OP],
            Operations: [{ op: 'replace', path: 'emails', value: [{ value: 'nope' }] }],
          },
          req,
        ),
      ).rejects.toMatchObject(invalid);
      expect(identityService.update).not.toHaveBeenCalled();
    });
  });

  describe('IdP changes (PUT, PATCH)', () => {
    const req = { get: () => 'localhost:3001', protocol: 'http', headers: {} } as never;
    const activeOp = (value: unknown) => ({
      schemas: [SCIM_SCHEMAS.PATCH_OP],
      Operations: [{ op: 'replace', path: 'active', value }],
    });

    it.each([
      [false, 'ACTIVE', 'INACTIVE'],
      [true, 'INACTIVE', 'ACTIVE'],
    ])(
      'PATCH active=%s turns a %s identity %s through the identity service',
      async (active, current, status) => {
        identityService.findById.mockResolvedValue({
          ...mockUser,
          status: current,
          toObject: undefined,
        } as never);
        identityService.update.mockResolvedValue({ ...mockUser, status } as never);

        await controller.patch('user-123', activeOp(active), req);

        // Only what the operation changes (hunt 2026-11-25, 02 F13), not the whole record
        expect(identityService.update).toHaveBeenCalledWith(
          'user-123',
          { status },
          'scim-inbound',
          { refuseHrMastered: true },
        );
      },
    );

    it("PUT replaces the IdP's attributes, active=false deactivating the identity", async () => {
      identityService.findById.mockResolvedValue(mockUser as never);
      identityService.update.mockResolvedValue({ ...mockUser } as never);

      await controller.replace(
        'user-123',
        {
          schemas: [SCIM_SCHEMAS.USER],
          userName: 'john@example.com',
          name: { givenName: 'Jonathan', familyName: 'Doe-Smith' },
          title: 'Staff Engineer',
          active: false,
        },
        req,
      );

      expect(identityService.update).toHaveBeenCalledWith(
        'user-123',
        expect.objectContaining({
          firstName: 'Jonathan',
          lastName: 'Doe-Smith',
          jobTitle: 'Staff Engineer',
          status: 'INACTIVE',
        }),
        'scim-inbound',
        { refuseHrMastered: true },
      );
    });

    it.each([
      [
        'PUT',
        () =>
          controller.replace(
            'unknown',
            { schemas: [SCIM_SCHEMAS.USER], userName: 'john@example.com' },
            req,
          ),
      ],
      ['PATCH', () => controller.patch('unknown', activeOp(false), req)],
    ])('%s answers 404 for an id the hub does not hold, writing nothing', async (_m, call) => {
      identityService.findById.mockResolvedValue(null);

      await expect(call()).rejects.toMatchObject({ scimStatus: '404', detail: 'User not found' });
      expect(identityService.update).not.toHaveBeenCalled();
    });

    it.each([
      [
        'PUT without a userName',
        () => controller.replace('user-123', { schemas: [SCIM_SCHEMAS.USER] }, req),
      ],
      [
        'PATCH without operations',
        () =>
          controller.patch('user-123', { schemas: [SCIM_SCHEMAS.PATCH_OP], Operations: [] }, req),
      ],
      [
        'PATCH with an operation SCIM does not have',
        () =>
          controller.patch(
            'user-123',
            { schemas: [SCIM_SCHEMAS.PATCH_OP], Operations: [{ op: 'move', path: 'active' }] },
            req,
          ),
      ],
    ])('%s answers 400 invalidValue, reading and writing nothing', async (_m, call) => {
      const error = await call().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SCIMError);
      expect(error).toMatchObject({
        scimType: 'invalidValue',
        scimStatus: '400',
        detail: expect.stringMatching(/^Validation failed: /),
      });
      expect(identityService.findById).not.toHaveBeenCalled();
      expect(identityService.update).not.toHaveBeenCalled();
    });
  });
});

/** The identity service's refusal of a change of an HR-mastered field. */
function refused(field: string, owner: string): HrMasteredFieldsException {
  return new HrMasteredFieldsException(
    [{ field, owner }],
    `${field} is mastered by ${owner}: change it in HR.`,
  );
}
