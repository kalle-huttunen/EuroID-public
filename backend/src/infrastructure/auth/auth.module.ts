import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MfaEnrollmentScopeGuard } from './mfa-enrollment-scope.guard';
import { RolesGuard } from './roles.guard';
import { TenantGuard } from './tenant.guard';
import { AuthLocalModule } from '../../modules/auth/auth-local.module';
import { TenantStatusModule } from '../multi-tenancy/tenant-status.service';

@Global()
@Module({
  imports: [AuthLocalModule, TenantStatusModule], // TenantStatusModule: a suspended tenant is refused
  providers: [
    // Order matters: JwtAuthGuard runs first (sets request['user']), MfaEnrollmentScopeGuard
    // second (an MFA enrollment token only on its routes), RolesGuard third, TenantGuard last
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: MfaEnrollmentScopeGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    // Also injectable: the websocket gateway checks a connection's token with it (authenticate).
    JwtAuthGuard,
  ],
  exports: [JwtAuthGuard],
})
export class AuthModule {}

// --- TASK_100: Import AuthLocalModule so JwtAuthGuard can inject AdminUser model.
