import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { AdConfig, AdUserDto } from './ad.interface';
import type { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';
import { isLinkedAdminProfile, targetAccountEnabled } from '@shared/utils/linked-admin-profile';

/**
 * Extract writeback-worthy attributes from AD provisioning result.
 */
export function extractWritebackAttributes(result: ProvisioningResult): Record<string, unknown> {
  const attrs = result.generatedAttributes;
  const payload: Record<string, unknown> = {};
  if (attrs?.mail || attrs?.userPrincipalName) {
    payload.email = attrs.mail || attrs.userPrincipalName;
  }
  if (attrs?.userPrincipalName) {
    payload.userPrincipalName = attrs.userPrincipalName;
  }
  if (attrs?.samAccountName) {
    payload.samAccountName = attrs.samAccountName;
  }
  if (attrs?.distinguishedName || result.targetUserId) {
    payload.distinguishedName = attrs?.distinguishedName || result.targetUserId;
  }
  if (result.targetUserId) {
    payload.objectId = result.targetUserId;
  }
  return payload;
}

/** AD userAccountControl: 512 = normal enabled account */
const UAC_NORMAL_ACCOUNT = 512;

/** AD userAccountControl: 514 = normal account with ACCOUNTDISABLE (0x2) set */
const UAC_DISABLED_ACCOUNT = 514;

/** objectClass for AD user */
const AD_USER_OBJECT_CLASS = ['top', 'person', 'organizationalPerson', 'user'];

/** Max length for sAMAccountName (AD limit) */
const SAM_ACCOUNT_NAME_MAX_LENGTH = 20;

/** The CN a user's account is named by: the display name, else first and last name. */
export function adCommonName(user: StandardUserDto): string {
  return user.displayName || `${user.firstName} ${user.lastName}`.trim();
}

/**
 * Pure mapping: StandardUserDto → AdUserDto. No HTTP, no side effects. 100% unit-testable.
 * `commonName`: the CN the caller chose when the person's name is taken in the OU (adCommonName
 * with a suffix); the display name stays the person's.
 */
export function toAdUser(
  user: StandardUserDto,
  config: AdConfig,
  sAMAccountName: string,
  userPrincipalName: string,
  commonName?: string,
): AdUserDto {
  const displayName = adCommonName(user);
  return {
    cn: commonName ?? displayName,
    sn: user.lastName,
    givenName: user.firstName,
    displayName,
    mail: userPrincipalName,
    sAMAccountName,
    userPrincipalName,
    objectClass: [...AD_USER_OBJECT_CLASS],
    // A linked admin account (PAM) is created disabled unless its session is active; any other
    // account is created enabled whatever its status, as before
    userAccountControl:
      isLinkedAdminProfile(user) && !targetAccountEnabled(user)
        ? UAC_DISABLED_ACCOUNT
        : UAC_NORMAL_ACCOUNT,
  };
}

/**
 * Build DN for a new user. Combines baseDn + optional userOu + CN (`commonName`, else
 * adCommonName). e.g. CN=John Doe,OU=Users,OU=Helsinki,DC=gov,DC=fi
 */
export function toDn(
  user: StandardUserDto,
  config: AdConfig,
  _sAMAccountName: string,
  commonName?: string,
): string {
  const cn = commonName ?? adCommonName(user);
  const rdn = `CN=${escapeDnValue(cn)}`;
  const parent = buildUserParentDn(config);
  return parent ? `${rdn},${parent}` : rdn;
}

function buildUserParentDn(config: AdConfig): string {
  const parts: string[] = [];
  if (config.userOu?.trim()) {
    parts.push(config.userOu.trim());
  }
  const base = config.userSearchBase?.trim() || config.rootBaseDn?.trim() || config.baseDn?.trim();
  if (base) {
    parts.push(base);
  }
  return parts.join(',');
}

/** Escape special characters in DN values (RFC 4514) */
function escapeDnValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/\+/g, '\\+')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/;/g, '\\;');
}

/**
 * Generate base sAMAccountName from user. Max 20 chars, no spaces, alphanumeric + underscore.
 * Caller must ensure uniqueness (e.g. append 1, 2 if conflict).
 */
export function generateSamAccountName(user: StandardUserDto): string {
  const base = (
    user.samAccountName ||
    user.email?.split('@')[0] ||
    `${user.firstName}.${user.lastName}`
  )
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/\./g, '')
    .slice(0, SAM_ACCOUNT_NAME_MAX_LENGTH);
  return base || 'user';
}
