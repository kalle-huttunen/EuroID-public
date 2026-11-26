/**
 * Bulk provisioning results as the API returns them (final and partial).
 *
 * The pre-change state a rollback restores is personal data. New runs keep it in the encrypted
 * rollback snapshot store and carry only `previousState.snapshotRef`; results recorded before
 * that carry the values in `systemResults[].previousState.attributes`. Those values are dropped
 * here, and every PII field left anywhere in the result is masked in the same format as identity
 * responses (identity-pii.ts).
 */
import { maskPiiDeep } from '../identity/identity-pii';

export function redactBulkResults<T>(body: T): T {
  return maskPiiDeep(dropSnapshotValues(body) as T);
}

function dropSnapshotValues(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(dropSnapshotValues);
  if (node === null || typeof node !== 'object' || node instanceof Date) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'previousState' && value !== null && typeof value === 'object') {
      const { attributes: _values, ...reference } = value as Record<string, unknown>;
      out[key] = reference;
    } else {
      out[key] = dropSnapshotValues(value);
    }
  }
  return out;
}
