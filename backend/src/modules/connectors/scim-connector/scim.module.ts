import { Module } from '@nestjs/common';
import { SCIMClient } from './scim.client';
import { SCIMMapper } from './scim.mapper';
import { SCIMService } from './scim.service';

@Module({
  providers: [
    SCIMClient, // 1. Low-level HTTP/Auth (SCIM protocol)
    SCIMMapper, // 2. Pure Translation Logic (StandardUserDto ↔ SCIMUser)
    SCIMService, // 3. High-level Orchestration (idempotent provision/deprovision)
  ],
  exports: [SCIMService],
})
export class ScimConnectorModule {}
