import { Injectable } from '@nestjs/common';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';

/** Max length for sAMAccountName (AD limit) */
const SAM_ACCOUNT_NAME_MAX_LENGTH = 20;

/**
 * Pure helpers for AD account name generation. No LDAP/network calls.
 * SAM uniqueness resolution is done by the activity layer (AdActivities) using AdClient.
 */
@Injectable()
export class AccountNameService {
  /**
   * Generate base sAMAccountName from user. Max 20 chars, no spaces, alphanumeric + underscore.
   * Caller must ensure uniqueness (e.g. append 1, 2 if conflict).
   */
  generateSamAccountName(user: StandardUserDto): string {
    const base = (
      user.samAccountName ||
      user.email?.split('@')[0] ||
      `${user.firstName}.${user.lastName}`
    )
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, SAM_ACCOUNT_NAME_MAX_LENGTH);
    return base || 'user';
  }

  /**
   * Build User Principal Name from user and domain.
   */
  buildUserPrincipalName(user: StandardUserDto, domain: string): string {
    if (user.userPrincipalName?.includes('@')) return user.userPrincipalName;
    if (user.email?.includes('@')) {
      const local = user.email.split('@')[0];
      const d = domain || user.email.split('@')[1];
      if (d) return domain ? `${local}@${domain}` : user.email;
    }
    const local =
      user.samAccountName ||
      user.email?.split('@')[0] ||
      `${user.firstName}.${user.lastName}`.toLowerCase();
    return domain ? `${local}@${domain}` : (user.email ?? '');
  }

  /**
   * Infer domain from Base DN (e.g. DC=gov,DC=fi -> gov.fi).
   */
  inferDomainFromBaseDn(baseDn: string): string {
    const parts = baseDn.split(',').filter((p) => p.trimStart().toUpperCase().startsWith('DC='));
    return parts.map((p) => p.replace(/^dc=/i, '').trim()).join('.');
  }
}
