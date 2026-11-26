/**
 * Credential Lifecycle Module
 *
 * Tracks credential state (password, MFA, passkeys, certificates) per identity
 * per target system. Provides credential policy management for rotation rules.
 */

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  CredentialInventory,
  CredentialInventorySchema,
} from './schemas/credential-inventory.schema';
import { CredentialPolicy, CredentialPolicySchema } from './schemas/credential-policy.schema';
import { CredentialInventoryService } from './credential-inventory.service';
import { CredentialPolicyService } from './credential-policy.service';
import { CredentialLifecycleController } from './credential-lifecycle.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CredentialInventory.name, schema: CredentialInventorySchema },
      { name: CredentialPolicy.name, schema: CredentialPolicySchema },
    ]),
  ],
  controllers: [CredentialLifecycleController],
  providers: [CredentialInventoryService, CredentialPolicyService],
  exports: [CredentialInventoryService, CredentialPolicyService],
})
export class CredentialLifecycleModule {}
