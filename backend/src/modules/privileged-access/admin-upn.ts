/**
 * The admin account UPN (the admin identity's email) from ADMIN_UPN_PATTERN. Pure: no I/O.
 *
 * Placeholders: `{firstName}`, `{lastName}`, `{domain}` (the parent's email domain) and `{tier}`
 * (`t0`, `t1`, `t2` for TIER_0, TIER_1, TIER_2). The default pattern has no `{tier}`, so a person
 * gets one admin UPN whatever the tier; a pattern with `{tier}` gives each tier its own.
 *
 * Name parts are lowercased with their whitespace removed, as before. Letters with diacritics
 * become their ASCII base letter (Mäkinen: makinen) and a few letters without a decomposition are
 * spelled out (ß: ss); anything else outside the characters Entra ID allows in a UPN's local part
 * is dropped. A name that gave an ASCII UPN before gives the same UPN now.
 */

/** Letters Unicode does not decompose into an ASCII base letter and a mark. */
const SPELLED_OUT: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
};

/** Characters Entra ID allows in a UPN's local part besides letters and digits. */
const NOT_ALLOWED = /[^a-z0-9.\-_'!#^~]/g;

/** `{tier}` for an admin tier: TIER_0 is `t0`; anything else is lowercased as is. */
export function tierToken(adminTier: string): string {
  const match = /^TIER_(\d+)$/i.exec(adminTier);
  return match ? `t${match[1]}` : adminTier.toLowerCase();
}

/** One name part of the UPN's local part, in ASCII (see the module comment). */
export function asciiUpnPart(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/./gu, (ch) => SPELLED_OUT[ch] ?? ch)
    .replace(NOT_ALLOWED, '');
}

export interface AdminUpnInput {
  firstName?: string;
  lastName?: string;
  /** The parent identity's email: its domain is `{domain}`. */
  email: string;
  adminTier: string;
}

/** The UPN the pattern gives the person's admin account of the tier. */
export function adminUpn(pattern: string, input: AdminUpnInput): string {
  const domain = input.email.includes('@') ? input.email.split('@')[1] : 'local';
  return pattern
    .replace(/\{firstName\}/gi, asciiUpnPart(input.firstName) || 'admin')
    .replace(/\{lastName\}/gi, asciiUpnPart(input.lastName) || 'user')
    .replace(/\{tier\}/gi, tierToken(input.adminTier))
    .replace(/\{domain\}/gi, domain);
}

/** The UPN with the number at the end of its local part: adm-ada.lovelace2@corp.example. */
export function withNumericSuffix(upn: string, n: number): string {
  const at = upn.lastIndexOf('@');
  return at < 0 ? `${upn}${n}` : `${upn.slice(0, at)}${n}${upn.slice(at)}`;
}
