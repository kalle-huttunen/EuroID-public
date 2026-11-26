import { Module } from '@nestjs/common';
import { OffboardingService } from './offboarding.service';
import { OffboardingEventHandler } from '../../infrastructure/events/handlers/offboarding-event.handler';
import { IdentityModule } from '../identity/identity.module';

@Module({
  // IdentityModule: the handler reads the address of the identity to offboard by its id
  imports: [IdentityModule],
  providers: [OffboardingService, OffboardingEventHandler],
  exports: [OffboardingService],
})
export class OffboardingModule {}
