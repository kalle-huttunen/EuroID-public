import { withTenantContext, getCurrentTenantId } from './tenant-context.helper';
import { requestContext } from '../middleware/correlation.middleware';

describe('tenant-context.helper', () => {

  describe('withTenantContext', () => {
    it('should set tenantId in AsyncLocalStorage', async () => {
      let capturedTenantId: string | undefined;
      await withTenantContext('tenant-123', async () => {
        capturedTenantId = getCurrentTenantId();
      });
      expect(capturedTenantId).toBe('tenant-123');
    });

    it('should return sync result', () => {
      const result = withTenantContext('t1', () => 42);
      expect(result).toBe(42);
    });

    it('should return async result', async () => {
      const result = await withTenantContext('t1', async () => 99);
      expect(result).toBe(99);
    });

    it('should accept options for actor and correlationId', async () => {
      let ctx: any;
      await withTenantContext(
        'tenant-x',
        async () => {
          ctx = requestContext.getStore();
        },
        { actor: 'admin@test.com', correlationId: 'corr-abc' },
      );
      expect(ctx?.tenantId).toBe('tenant-x');
      expect(ctx?.actor).toBe('admin@test.com');
      expect(ctx?.correlationId).toBe('corr-abc');
    });
  });

  describe('getCurrentTenantId', () => {
    it('should return tenantId from context', async () => {
      await withTenantContext('my-tenant', async () => {
        expect(getCurrentTenantId()).toBe('my-tenant');
      });
    });

    it('should throw when no context is set', () => {
      expect(() => getCurrentTenantId()).toThrow(
        'No tenant context available. Ensure request has tenantId or use withTenantContext().',
      );
    });

    it('should throw when context has empty tenantId', async () => {
      requestContext.run({ correlationId: 'x', actor: 'a', tenantId: '', startTime: 0 }, () => {
        expect(() => getCurrentTenantId()).toThrow(
          'No tenant context available. Ensure request has tenantId or use withTenantContext().',
        );
      });
    });
  });
});
