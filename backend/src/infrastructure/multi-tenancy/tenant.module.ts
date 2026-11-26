import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import * as mongoose from 'mongoose';
import { tenantPlugin } from './tenant.plugin';
import { TenantContextInterceptor } from './tenant-context.interceptor';
import { Tenant, TenantSchema } from './schemas/tenant.schema';
import { TenantService } from './tenant.service';
import { TenantStatusModule } from './tenant-status.service';
import { TenantController } from './tenant.controller';
import { AuthLocalModule } from '../../modules/auth/auth-local.module';

// Register plugin at module load time — before any SchemaFactory.createForClass() executes.
mongoose.plugin(tenantPlugin);

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Tenant.name, schema: TenantSchema }]),
    AuthLocalModule, // AdminUser model and auth services (the controller uses the global guards)
    TenantStatusModule, // TenantService drops a changed tenant's cached status
  ],
  controllers: [TenantController],
  providers: [
    TenantService,
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantContextInterceptor,
    },
  ],
  exports: [TenantService, TenantStatusModule],
})
export class TenantModule {}
