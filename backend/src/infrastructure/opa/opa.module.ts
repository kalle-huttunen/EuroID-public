/**
 * OPA Module — Global Open Policy Agent Infrastructure
 *
 * Provides OpaClientService globally. When OPA_ENABLED=false (default),
 * the client reports isAvailable()=false and all queries return null.
 */
import { Global, Module } from '@nestjs/common';
import { OpaClientService } from './opa-client.service';

@Global()
@Module({
  providers: [OpaClientService],
  exports: [OpaClientService],
})
export class OpaModule {}
