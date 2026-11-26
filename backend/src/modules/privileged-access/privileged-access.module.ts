import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { IdentityModule } from '../identity/identity.module';
import { PrivilegedAccessService } from './privileged-access.service';
import { PrivilegedAccessController } from './privileged-access.controller';
import { PamSessionService } from './pam-session.service';
import { PamSessionStateService } from './pam-session-state.service';
import { PrivilegedSessionService } from './privileged-session.service';
import { PamSessionEndHandler } from './pam-session-end.handler';
import { pamConfig } from '@infrastructure/config/pam.config';

@Module({
  imports: [
    ConfigModule.forFeature(pamConfig),
    MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
    IdentityModule,
  ],
  controllers: [PrivilegedAccessController],
  providers: [
    PrivilegedAccessService,
    PamSessionService,
    PamSessionStateService,
    PrivilegedSessionService,
    PamSessionEndHandler,
  ],
  exports: [PrivilegedAccessService, PamSessionService, PamSessionStateService],
})
export class PrivilegedAccessModule {}
