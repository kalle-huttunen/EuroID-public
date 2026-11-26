/**
 * MfaEnrollmentScopeGuard over HTTP, with the real auth controllers and the global guards in
 * AuthModule's order: the MFA enrollment token of a sign-in in a tenant that requires MFA reaches
 * MFA setup, the session check and sign-out, and nothing else (POST /auth/change-password among
 * the refused). Other tokens are unaffected. The services are stubs: no database.
 */

import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from '@anatine/zod-nestjs';
import * as request from 'supertest';
import { authConfig } from '@infrastructure/config/auth.config';
import { AdminUsersService } from '../../modules/auth/admin-users.service';
import { AuthLocalController } from '../../modules/auth/auth-local.controller';
import { emptyBodyAsObject } from '../middleware/empty-body.middleware';
import { AuthLocalService } from '../../modules/auth/auth-local.service';
import { MfaController } from '../../modules/auth/mfa.controller';
import { MfaService } from '../../modules/auth/mfa.service';
import { MfaEnrollmentScopeGuard } from './mfa-enrollment-scope.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { RolesGuard } from './roles.guard';

/** Test stand-in for JwtAuthGuard: the caller named in x-test-user (none on a public route). */
@Injectable()
class TestAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const req = context.switchToHttp().getRequest();
    const header = req.headers['x-test-user'];
    if (typeof header === 'string') req.user = JSON.parse(header);
    return true;
  }
}

/** Any route of another module that needs no role, as most reads do. */
@Controller('identity')
class AnyOtherController {
  @Get()
  list() {
    return { items: [] };
  }
}

const SUB = '65f0c1a2b3c4d5e6f7a8b9c0';
const caller = (fields: object) => ({
  'x-test-user': JSON.stringify({
    sub: SUB,
    email: 'mia@tenant-mfa.example',
    name: 'Mia Mfa',
    tenantId: 'tenant-mfa',
    ...fields,
  }),
});
/** The token AuthLocalService.signScopedJwt issues for MFA setup, as JwtAuthGuard reads it. */
const ENROLLMENT = caller({ roles: [], scope: 'mfa-enrollment' });
const VIEWER = caller({ roles: ['viewer'] });
/** A token without a role or scope (an OIDC token without a roles claim). */
const ROLE_LESS = caller({ roles: [] });

const NEW_PASSWORD = 'NewValidPass1!xx';
const ENROLLMENT_ONLY = /can only set up MFA/;

describe('MfaEnrollmentScopeGuard (HTTP, global guards)', () => {
  let app: INestApplication;
  const mfa = {
    setupMfa: jest.fn().mockResolvedValue({ qrCodeDataUrl: 'data:,', manualEntryKey: 'KEY' }),
    verifySetup: jest.fn().mockResolvedValue({ backupCodes: ['code-1'] }),
    getMfaStatus: jest.fn().mockResolvedValue({ mfaEnabled: false, backupCodesRemaining: 0 }),
    disableMfa: jest.fn().mockResolvedValue(undefined),
    regenerateBackupCodes: jest.fn().mockResolvedValue({ backupCodes: ['code-1'] }),
  };
  const authLocal = {
    changePassword: jest.fn().mockResolvedValue(undefined),
    listAdmins: jest.fn().mockResolvedValue([]),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthLocalController, MfaController, AnyOtherController],
      providers: [
        { provide: AuthLocalService, useValue: authLocal },
        { provide: AdminUsersService, useValue: {} },
        { provide: MfaService, useValue: mfa },
        { provide: authConfig.KEY, useValue: { PLATFORM_ADMIN_USER_IDS: '' } },
        // AuthModule's order: authentication, MFA enrollment scope, roles.
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: MfaEnrollmentScopeGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use(emptyBodyAsObject); // as main.ts: {} for a request without a body (POST /auth/logout)
    app.useGlobalPipes(new ZodValidationPipe());
    await app.init();
  });

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  describe('the MFA enrollment token', () => {
    it('reaches the routes of MFA setup', async () => {
      await http().get('/api/v1/auth/mfa/status').set(ENROLLMENT).expect(200);
      await http().post('/api/v1/auth/mfa/setup').set(ENROLLMENT).expect(201);
      await http()
        .post('/api/v1/auth/mfa/verify-setup')
        .set(ENROLLMENT)
        .send({ code: '123456' })
        .expect(201);

      expect(mfa.getMfaStatus).toHaveBeenCalledWith(SUB);
      expect(mfa.setupMfa).toHaveBeenCalledWith(SUB);
      expect(mfa.verifySetup).toHaveBeenCalledWith(SUB, '123456');
    });

    it('reaches the session check and sign-out', async () => {
      const me = await http().get('/api/v1/auth/me').set(ENROLLMENT).expect(200);
      expect(me.body).toMatchObject({ sub: SUB, roles: [], tenantId: 'tenant-mfa' });
      // Public: no token is checked.
      await http().post('/api/v1/auth/logout').set(ENROLLMENT).expect(201);
    });

    it('cannot change the password', async () => {
      const res = await http()
        .post('/api/v1/auth/change-password')
        .set(ENROLLMENT)
        .send({ currentPassword: 'ValidPass1!xx', newPassword: NEW_PASSWORD })
        .expect(403);

      expect(res.body.message).toMatch(ENROLLMENT_ONLY);
      expect(authLocal.changePassword).not.toHaveBeenCalled();
    });

    it.each<[string, string]>([
      ['POST', '/api/v1/auth/mfa/disable'],
      ['POST', '/api/v1/auth/mfa/backup-codes'],
      ['GET', '/api/v1/auth/users'],
      ['GET', '/api/v1/identity'],
    ])('is refused on %s %s, with a message that says what to do', async (method, path) => {
      const req = method === 'GET' ? http().get(path) : http().post(path).send({ code: '123456' });
      const res = await req.set(ENROLLMENT).expect(403);

      expect(res.body.message).toMatch(ENROLLMENT_ONLY);
      expect(mfa.disableMfa).not.toHaveBeenCalled();
      expect(mfa.regenerateBackupCodes).not.toHaveBeenCalled();
      expect(authLocal.listAdmins).not.toHaveBeenCalled();
    });
  });

  describe('other tokens', () => {
    it('a token with a role changes its password and reads routes as before', async () => {
      await http()
        .post('/api/v1/auth/change-password')
        .set(VIEWER)
        .send({ currentPassword: 'ValidPass1!xx', newPassword: NEW_PASSWORD })
        .expect(201);
      await http().get('/api/v1/identity').set(VIEWER).expect(200);
      await http().post('/api/v1/auth/mfa/setup').set(VIEWER).expect(201);

      expect(authLocal.changePassword).toHaveBeenCalledWith(SUB, 'ValidPass1!xx', NEW_PASSWORD);
    });

    it('a token with no role or scope still cannot set up MFA, but reads its status', async () => {
      const res = await http().post('/api/v1/auth/mfa/setup').set(ROLE_LESS).expect(403);
      expect(res.body.message).toMatch(/requires an MFA enrollment token/);
      await http().get('/api/v1/auth/mfa/status').set(ROLE_LESS).expect(200);
      expect(mfa.setupMfa).not.toHaveBeenCalled();
    });
  });
});
