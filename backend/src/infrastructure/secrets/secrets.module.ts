/**
 * SecretsModule — provides encryption and credential generation
 *
 * Global module: EncryptionService for secrets at rest,
 * CredentialGenerationService for target system password generation.
 */

import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';
import { CredentialGenerationService } from './credential-generation.service';

@Global()
@Module({
  providers: [EncryptionService, CredentialGenerationService],
  exports: [EncryptionService, CredentialGenerationService],
})
export class SecretsModule {}
