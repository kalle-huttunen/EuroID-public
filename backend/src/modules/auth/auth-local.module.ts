import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminUser, AdminUserSchema } from './schemas/admin-user.schema';
import { Tenant, TenantSchema } from '@infrastructure/multi-tenancy/schemas/tenant.schema';
import { Invite, InviteSchema } from './schemas/invite.schema';
import { AuthLocalService } from './auth-local.service';
import { AuthLocalController } from './auth-local.controller';
import { AdminUsersService } from './admin-users.service';
import { InviteController } from './invite.controller';
import { InviteService } from './invite.service';
import { MfaService } from './mfa.service';
import { MfaController } from './mfa.controller';
import { SamlAuthService } from './saml-auth.service';
import { SamlAuthController } from './saml-auth.controller';
import { IdentityModule } from '../identity/identity.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PasswordResetService } from './password-reset.service';
import { PasswordResetController } from './password-reset.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AdminUser.name, schema: AdminUserSchema },
      { name: Tenant.name, schema: TenantSchema },
      { name: Invite.name, schema: InviteSchema },
    ]),
    ConfigModule,
    IdentityModule,
    NotificationsModule, // PasswordResetMailService: the password reset link by email
  ],
  providers: [
    AuthLocalService,
    AdminUsersService,
    InviteService,
    PasswordResetService,
    MfaService,
    SamlAuthService,
  ],
  controllers: [
    AuthLocalController,
    InviteController,
    PasswordResetController,
    MfaController,
    SamlAuthController,
  ],
  exports: [
    AuthLocalService,
    MfaService,
    SamlAuthService,
    MongooseModule.forFeature([{ name: AdminUser.name, schema: AdminUserSchema }]),
  ],
})
export class AuthLocalModule {}

// --- TASK_100: Export MongooseModule.forFeature([AdminUser]) for JwtAuthGuard.
