/**
 * LDAP utility functions. Pure, no side effects.
 */

/** Escape special characters for LDAP filter values (RFC 4515). */
export function escapeLdapFilter(value: string): string {
  return value
    .replace(/\\/g, '\\5c')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\*/g, '\\2a')
    .replace(/\0/g, '\\00');
}

/** Whether two DNs name the same entry: case and the spaces around commas do not count. */
export function sameDn(a: string, b: string): boolean {
  const norm = (dn: string) =>
    dn
      .trim()
      .toLowerCase()
      .replace(/\s*,\s*/g, ',');
  return norm(a) === norm(b);
}
