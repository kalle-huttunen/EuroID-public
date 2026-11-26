import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { BatchProvisionController } from './batch-provision.controller';
import { BatchProvisionService } from './batch-provision.service';
import { IdentityModule } from '../identity/identity.module';
import { EntraConnectorModule } from '../connectors/entra-connector/entra.module';
import { OnboardingEventHandler } from '../../infrastructure/events/handlers/onboarding.handler';
import { SourcesChangedHandler } from '../../infrastructure/events/handlers/sources-changed.handler';
import { JoinerEvent, JoinerEventSchema } from '../joiners/schemas/joiner-event.schema';

@Module({
  imports: [
    IdentityModule,
    EntraConnectorModule,
    // Read only: the handlers start no onboarding for an open HR joiner (joiners/open-joiner.ts)
    MongooseModule.forFeature([{ name: JoinerEvent.name, schema: JoinerEventSchema }]),
  ],
  controllers: [OnboardingController, BatchProvisionController],
  providers: [
    OnboardingService,
    BatchProvisionService,
    OnboardingEventHandler,
    SourcesChangedHandler,
  ],
  exports: [OnboardingService],
})
export class OnboardingModule {}
