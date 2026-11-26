/**
 * Masking of connector secrets in API responses, and the save rule that goes with it.
 *
 * Responses replace a secret value with SECRET_PLACEHOLDER. A client that edits a config sends
 * the whole config back, so a save treats the placeholder as "keep the stored value". Which keys
 * are secret is the caller's decision (normally the connector manifest's `type: 'password'`
 * fields, PluginRegistryService.getSecretConfigKeys).
 */

/** What a response carries in place of a secret value; sent back on save, it keeps the stored value. */
export const SECRET_PLACEHOLDER = '••••••••';

/**
 * Key-name fallback: keys containing these fragments may hold credentials. Only for payloads
 * that no connector manifest describes, where a key name is the only signal left and
 * over-masking a non-secret is cheaper than leaking a secret.
 */
const SECRET_NAME_FRAGMENTS = [
  'clientSecret',
  'password',
  'apiKey',
  'secret',
  'token',
  'serviceAccount',
];

export function isSecretByName(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_NAME_FRAGMENTS.some((s) => lower.includes(s.toLowerCase()));
}

const hasValue = (value: unknown) => value !== undefined && value !== null && value !== '';

/** Copy of a flat config with every secret that has a value replaced by SECRET_PLACEHOLDER. */
export function maskSecrets(
  config: Record<string, unknown>,
  isSecret: (key: string) => boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = isSecret(key) && hasValue(value) ? SECRET_PLACEHOLDER : value;
  }
  return out;
}

/**
 * The config to store when a client saves `incoming` over `stored`. For a secret key:
 * SECRET_PLACEHOLDER keeps the stored value (and is dropped when nothing is stored), an empty
 * string or null clears it (the key is removed), any other value replaces it. Other keys are
 * taken as sent.
 */
export function restoreMaskedSecrets(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | undefined,
  isSecret: (key: string) => boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!isSecret(key)) {
      out[key] = value;
    } else if (value === SECRET_PLACEHOLDER) {
      if (stored && hasValue(stored[key])) out[key] = stored[key];
    } else if (hasValue(value)) {
      out[key] = value;
    }
  }
  return out;
}

/** Whether any secret key of `config` still holds the placeholder (it needs the stored config). */
export function hasMaskedSecret(
  config: Record<string, unknown>,
  isSecret: (key: string) => boolean,
): boolean {
  return Object.entries(config).some(
    ([key, value]) => value === SECRET_PLACEHOLDER && isSecret(key),
  );
}
