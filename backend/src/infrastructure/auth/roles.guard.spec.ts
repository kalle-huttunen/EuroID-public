import { RolesGuard } from './roles.guard';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function createMockContext(user: any, requiredRoles: string[] | undefined): ExecutionContext {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(requiredRoles);

    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  }

  it('should allow access when no roles are required', () => {
    const ctx = createMockContext({ roles: ['viewer'] }, undefined);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow access when roles array is empty', () => {
    const ctx = createMockContext({ roles: ['viewer'] }, []);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow super-admin to access any role-protected endpoint', () => {
    const ctx = createMockContext({ roles: ['super-admin'] }, ['viewer']);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow super-admin to access policy-admin endpoints', () => {
    const ctx = createMockContext({ roles: ['super-admin'] }, ['policy-admin']);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should deny viewer access to policy-admin endpoint', () => {
    const ctx = createMockContext({ roles: ['viewer'] }, ['policy-admin']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should deny operator access to connector-admin endpoint', () => {
    const ctx = createMockContext({ roles: ['operator'] }, ['connector-admin']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should allow policy-admin to access operator endpoints (hierarchy)', () => {
    const ctx = createMockContext({ roles: ['policy-admin'] }, ['operator']);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should throw ForbiddenException when user has no roles', () => {
    const ctx = createMockContext({ roles: undefined }, ['viewer']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when no user object', () => {
    const ctx = createMockContext(undefined, ['viewer']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should handle multiple user roles', () => {
    const ctx = createMockContext({ roles: ['viewer', 'policy-admin'] }, ['connector-admin']);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should allow when user has one of the required roles', () => {
    const ctx = createMockContext({ roles: ['operator'] }, ['operator', 'policy-admin']);
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
