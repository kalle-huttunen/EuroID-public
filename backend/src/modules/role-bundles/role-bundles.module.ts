import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RoleBundle, RoleBundleSchema } from './schemas/role-bundle.schema';
import { RoleBundlesService } from './role-bundles.service';
import { RoleBundlesController } from './role-bundles.controller';
import { Policy, PolicySchema } from '../policy/schemas/policy.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RoleBundle.name, schema: RoleBundleSchema },
      { name: Policy.name, schema: PolicySchema },
    ]),
  ],
  controllers: [RoleBundlesController],
  providers: [RoleBundlesService],
  exports: [RoleBundlesService],
})
export class RoleBundlesModule {}
