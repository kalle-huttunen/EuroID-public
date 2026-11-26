import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  sub: string;
  email: string;
  name: string;
  roles: string[];
  tenantId: string;
}

/** Extract the authenticated user from the request: @AuthUser() user: AuthUser */
export const AuthUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest()['user'];
  },
);
