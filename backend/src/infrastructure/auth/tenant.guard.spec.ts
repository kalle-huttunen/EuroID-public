import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SystemOperation } from '../multi-tenancy/system-operation.decorator';
import { Public } from './public.decorator';
import { TenantGuard } from './tenant.guard';

/** Handlers as a controller declares them: the guard reads the real decorators' metadata. */
class ProbeController {
  @Public()
  open() {}

  @SystemOperation()
  system() {}

  plain() {}
}

describe('TenantGuard', () => {
  let guard: TenantGuard;

  beforeEach(() => {
    guard = new TenantGuard(new Reflector());
  });

  function createMockContext(
    user: { tenantId?: string; email?: string } | undefined,
    handler: keyof ProbeController = 'plain',
  ): ExecutionContext {
    const request = { user };
    return {
      getHandler: () => ProbeController.prototype[handler],
      getClass: () => ProbeController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  it('should pass when tenantId is present', () => {
    const ctx = createMockContext({ tenantId: 'tenant-123', email: 'user@test.com' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should throw ForbiddenException when tenantId is missing', () => {
    const ctx = createMockContext({ email: 'user@test.com' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx)).toThrow(
      'Tenant context is required. Ensure JWT contains tenantId claim.',
    );
  });

  it('should throw ForbiddenException when user is undefined', () => {
    const ctx = createMockContext(undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it.each<[string, keyof ProbeController]>([
    ['@Public()', 'open'],
    ['@SystemOperation()', 'system'],
  ])('should skip for %s endpoints', (_decorator, handler) => {
    const ctx = createMockContext(undefined, handler);
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
