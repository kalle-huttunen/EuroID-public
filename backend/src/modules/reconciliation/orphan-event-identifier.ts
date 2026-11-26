/**
 * The accountIdentifier of orphan.detected, which reaches the audit log, the tenant websocket and
 * webhooks: the target's own key for an account no identity owns, never its address.
 *
 * The account's id where it is opaque (an Entra ID object id, a SCIM id). An AD account's id is
 * its DN, whose CN is the person's name, and an id may be an address: then a masked form, the
 * account's UPN or mail through maskEmail (`a•••@corp.example`), else the id with its emails and
 * DN names masked.
 */
import { maskEmail } from '../identity/identity-pii';
import { maskPersonalData } from '../../activities/deprovision-failure';

/** An address, or an LDAP DN (`CN=..,OU=..,DC=..`). */
const NOT_OPAQUE = /@|\b(CN|UID|OU|DC)=/i;

export function orphanEventIdentifier(externalId: string, address?: string): string {
  if (!NOT_OPAQUE.test(externalId)) return externalId;
  return address?.includes('@') ? maskEmail(address) : maskPersonalData(externalId);
}
