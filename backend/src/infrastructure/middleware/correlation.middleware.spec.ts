import { CorrelationMiddleware, requestContext } from './correlation.middleware';
import { Request, Response } from 'express';

describe('CorrelationMiddleware', () => {
  let middleware: CorrelationMiddleware;

  beforeEach(() => {
    middleware = new CorrelationMiddleware();
  });

  function createMockReqRes(headers: Record<string, string> = {}) {
    const req = { headers } as unknown as Request;
    const res = {
      setHeader: jest.fn(),
    } as unknown as Response;
    return { req, res };
  }

  it('should generate a correlation ID when none provided', (done) => {
    const { req, res } = createMockReqRes();

    middleware.use(req, res, () => {
      const ctx = requestContext.getStore();
      expect(ctx).toBeDefined();
      expect(ctx!.correlationId).toBeTruthy();
      expect(ctx!.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      done();
    });
  });

  it('should use the X-Correlation-ID header when provided', (done) => {
    const { req, res } = createMockReqRes({ 'x-correlation-id': 'my-trace-123' });

    middleware.use(req, res, () => {
      const ctx = requestContext.getStore();
      expect(ctx!.correlationId).toBe('my-trace-123');
      done();
    });
  });

  it('should echo correlation ID back in response header', (done) => {
    const { req, res } = createMockReqRes();

    middleware.use(req, res, () => {
      expect(res.setHeader).toHaveBeenCalledWith('X-Correlation-ID', expect.any(String));
      done();
    });
  });

  it('should set actor to anonymous initially', (done) => {
    const { req, res } = createMockReqRes();

    middleware.use(req, res, () => {
      const ctx = requestContext.getStore();
      expect(ctx!.actor).toBe('anonymous');
      done();
    });
  });

  it('should set tenantId to empty initially (populated by TenantContextInterceptor after guards)', (done) => {
    const { req, res } = createMockReqRes();

    middleware.use(req, res, () => {
      const ctx = requestContext.getStore();
      expect(ctx!.tenantId).toBe('');
      done();
    });
  });

  it('should set startTime to current timestamp', (done) => {
    const before = Date.now();
    const { req, res } = createMockReqRes();

    middleware.use(req, res, () => {
      const ctx = requestContext.getStore();
      expect(ctx!.startTime).toBeGreaterThanOrEqual(before);
      expect(ctx!.startTime).toBeLessThanOrEqual(Date.now());
      done();
    });
  });

  it('should isolate context between concurrent requests', (done) => {
    const { req: req1, res: res1 } = createMockReqRes({ 'x-correlation-id': 'request-1' });
    const { req: req2, res: res2 } = createMockReqRes({ 'x-correlation-id': 'request-2' });

    let id1: string | undefined;
    let id2: string | undefined;

    middleware.use(req1, res1, () => {
      id1 = requestContext.getStore()?.correlationId;

      middleware.use(req2, res2, () => {
        id2 = requestContext.getStore()?.correlationId;
        expect(id1).toBe('request-1');
        expect(id2).toBe('request-2');
        done();
      });
    });
  });
});
