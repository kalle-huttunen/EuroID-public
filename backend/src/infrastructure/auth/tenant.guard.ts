import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { IS_SYSTEM_OPERATION } from '../multi-tenancy/system-operation.decorator';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const isSystem = this.reflector.getAllAndOverride<boolean>(
      IS_SYSTEM_OPERATION,
      [context.getHandler(), context.getClass()],
    );
    if (isSystem) return true;

    const request = context.switchToHttp().getRequest();
    const tenantId = request['user']?.tenantId;

    if (!tenantId) {
      throw new ForbiddenException(
        'Tenant context is required. Ensure JWT contains tenantId claim.',
      );
    }

    return true;
  }
}
