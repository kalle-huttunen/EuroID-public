/**
 * Credential Activities Module
 *
 * Provides the credential state reads (Entra ID, AD) that the nightly credential run's
 * inventory refresh uses.
 */
import { Module } from '@nestjs/common';
import { CredentialActivities } from './credential.activities';
import { EntraConnectorModule } from '../modules/connectors/entra-connector/entra.module';
import { AdConnectorModule } from '../modules/connectors/ad-connector/ad.module';

@Module({
  imports: [EntraConnectorModule, AdConnectorModule],
  providers: [CredentialActivities],
  exports: [CredentialActivities],
})
export class CredentialActivitiesModule {}
