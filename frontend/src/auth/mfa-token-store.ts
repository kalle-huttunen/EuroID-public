/**
 * In-memory MFA token store.
 * Survives in-app navigation (e.g. SAML callback → Login) but not persisted to browser storage.
 * Prevents XSS token theft from sessionStorage.
 */

let mfaToken: string | null = null;

export function setMfaToken(token: string): void {
  mfaToken = token;
}

export function getMfaToken(): string | null {
  return mfaToken;
}

export function clearMfaToken(): void {
  mfaToken = null;
}
