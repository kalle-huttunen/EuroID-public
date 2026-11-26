import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { requestContext } from '../middleware/correlation.middleware';

/**
 * Updates AsyncLocalStorage context with tenantId from the authenticated user.
 * Runs after guards (JwtAuthGuard, RolesGuard), so request['user'] is available.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const user = request['user'];
    const ctx = requestContext.getStore();

    if (ctx && user?.tenantId) {
      (ctx as { tenantId: string; actor?: string }).tenantId = user.tenantId;
      (ctx as { tenantId: string; actor?: string }).actor = user.email || ctx.actor;
    }

    return next.handle();
  }
}
