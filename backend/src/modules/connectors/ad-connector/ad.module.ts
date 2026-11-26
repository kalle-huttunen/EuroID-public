import { Module } from '@nestjs/common';
import { AdService } from './ad.service';
import { AdClient } from './ad.client';
import { AccountNameService } from './account-name.service';

/**
 * Active Directory connector module. Provisions users via LDAP/LDAPS.
 * Pure dumb pipe: field mapping + LDAP calls only. No domain services or event emission.
 */
@Module({
  providers: [AdClient, AdService, AccountNameService],
  exports: [AdService, AdClient, AccountNameService],
})
export class AdConnectorModule {}
