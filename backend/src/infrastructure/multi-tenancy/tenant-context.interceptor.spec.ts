import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { RequestContext, requestContext } from '../middleware/correlation.middleware';
import { TenantContextInterceptor } from './tenant-context.interceptor';

/**
 * After the guards, the request context (which the tenant plugin scopes every query by) takes the
 * tenant and actor of the authenticated user; a request without one keeps the context it had.
 */
describe('TenantContextInterceptor', () => {
  const interceptor = new TenantContextInterceptor();

  /** Runs the interceptor for a request of `user` inside a fresh request context. */
  async function contextAfter(user: object | undefined): Promise<RequestContext> {
    const ctx: RequestContext = {
      correlationId: 'c-1',
      actor: 'anonymous',
      tenantId: '',
      startTime: 0,
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: jest.fn(() => of('handled')) };

    await requestContext.run(ctx, async () => {
      await expect(lastValueFrom(interceptor.intercept(context, next))).resolves.toBe('handled');
    });
    expect(next.handle).toHaveBeenCalledTimes(1);
    return ctx;
  }

  it('sets the tenant and the actor from the authenticated user', async () => {
    const ctx = await contextAfter({ tenantId: 'tenant-a', email: 'admin@tenant-a.example' });

    expect(ctx).toMatchObject({ tenantId: 'tenant-a', actor: 'admin@tenant-a.example' });
  });

  it('keeps the actor when the user has no email', async () => {
    const ctx = await contextAfter({ tenantId: 'tenant-a', sub: 'svc-1' });

    expect(ctx).toMatchObject({ tenantId: 'tenant-a', actor: 'anonymous' });
  });

  it.each([
    ['an unauthenticated request', undefined],
    ['a user without a tenant', { email: 'admin@tenant-a.example' }],
  ])('leaves the context untouched for %s', async (_case, user) => {
    const ctx = await contextAfter(user);

    expect(ctx).toMatchObject({ tenantId: '', actor: 'anonymous' });
  });
});
