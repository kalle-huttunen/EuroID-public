/**
 * The form an identity's email is stored and compared in: trimmed and lower-cased. Identity
 * providers and HR systems send the same address in different cases ("Jane.Doe@x.fi" from Entra,
 * "jane.doe@x.fi" from HR), and correlation, the held-row check and the unique email index
 * compare the stored value exactly, so every write normalizes it and every lookup asks for the
 * normalized value. Pure, so workflow code may import it.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Whether two emails are the same address in another case or with surrounding spaces. */
export function sameEmail(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && normalizeEmail(a) === normalizeEmail(b);
}
