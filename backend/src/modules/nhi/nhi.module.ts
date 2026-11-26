/**
 * NHI (Non-Human Identity) Module
 *
 * First-class domain for service accounts, workloads, and AI agents. Keeps
 * agent identities and their short-lived credentials separate from the human
 * Identity Onion so their distinct lifecycle (owner, scope, expiresAt,
 * kill-switch) can be modelled directly.
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AgentIdentity, AgentIdentitySchema } from './schemas/agent-identity.schema';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { NhiService } from './nhi.service';
import { NhiCredentialService } from './nhi-credential.service';
import { NhiController } from './nhi.controller';
import { NhiOwnershipService } from './nhi-ownership.service';
import { NhiOwnerLeftHandler } from './nhi-owner-left.handler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AgentIdentity.name, schema: AgentIdentitySchema },
      { name: Identity.name, schema: IdentitySchema },
    ]),
  ],
  controllers: [NhiController],
  providers: [NhiService, NhiCredentialService, NhiOwnershipService, NhiOwnerLeftHandler],
  // NhiOwnershipService: a GDPR erasure marks the erased owner's agents ownerless through it
  exports: [NhiService, NhiCredentialService, NhiOwnershipService],
})
export class NhiModule {}
