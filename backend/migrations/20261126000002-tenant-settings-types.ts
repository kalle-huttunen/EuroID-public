/**
 * Migration: tenant settings get the types PATCH /tenants/:id requires.
 *
 * Before this release the settings PATCH stored whatever it was sent, so a tenant could hold
 * `mfaRequired: "false"` (read as true) or `maxIdentities: "500"`. The PATCH now validates each
 * setting's type (TenantSettingsPatchSchema, tenant.dtos.ts), and the console's edit form sends
 * the stored settings back, so every edit of such a tenant answered 400 (filed by HX-A).
 *
 * For each known key it stores the value as its type when it can be read as one:
 * - mfaRequired: true/false, "true"/"false" (any case, trimmed), 1/0, "1"/"0"
 * - maxIdentities, retentionDays: a positive integer, or a string of digits naming one
 * - allowedConnectors: an array of strings (trimmed, empty ones dropped), or a comma-separated
 *   string
 * - features: an object whose values are read as mfaRequired is, key by key
 * A value that cannot be read is removed and logged with the tenant id and key (never the value),
 * as a PATCH with null would remove it. Other keys stay. Rerunning it changes nothing.
 */
import { Db } from 'mongodb';

type Coerced = { ok: true; value: unknown } | { ok: false };
const unreadable: Coerced = { ok: false };

function asBoolean(value: unknown): Coerced {
  if (typeof value === 'boolean') return { ok: true, value };
  if (value === 1 || value === 0) return { ok: true, value: value === 1 };
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1') return { ok: true, value: true };
    if (text === 'false' || text === '0') return { ok: true, value: false };
  }
  return unreadable;
}

function asPositiveInteger(value: unknown): Coerced {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n > 0 ? { ok: true, value: n } : unreadable;
}

function asStringList(value: unknown): Coerced {
  const items = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(items) || !items.every((i) => typeof i === 'string')) return unreadable;
  return { ok: true, value: (items as string[]).map((i) => i.trim()).filter(Boolean) };
}

const SCALARS: Record<string, (value: unknown) => Coerced> = {
  mfaRequired: asBoolean,
  maxIdentities: asPositiveInteger,
  retentionDays: asPositiveInteger,
  allowedConnectors: asStringList,
};

/** The $set and $unset that type one tenant's settings, and the paths removed. */
function plan(settings: Record<string, unknown>) {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, ''> = {};
  const record = (path: string, current: unknown, coerced: Coerced) => {
    if (!coerced.ok) $unset[path] = '';
    else if (JSON.stringify(coerced.value) !== JSON.stringify(current)) $set[path] = coerced.value;
  };
  for (const [key, coerce] of Object.entries(SCALARS)) {
    if (key in settings && settings[key] !== undefined) {
      record(`settings.${key}`, settings[key], coerce(settings[key]));
    }
  }
  const features = settings.features;
  if (features !== undefined) {
    if (features === null || typeof features !== 'object' || Array.isArray(features)) {
      $unset['settings.features'] = '';
    } else {
      for (const [name, value] of Object.entries(features as Record<string, unknown>)) {
        record(`settings.features.${name}`, value, asBoolean(value));
      }
    }
  }
  return { $set, $unset };
}

export async function up(db: Db): Promise<void> {
  const tenants = db.collection('tenants');
  const cursor = tenants.find(
    { settings: { $type: 'object' } },
    { projection: { tenantId: 1, settings: 1 } },
  );
  let changed = 0;
  for await (const tenant of cursor) {
    const { $set, $unset } = plan(tenant.settings as Record<string, unknown>);
    if (Object.keys($set).length === 0 && Object.keys($unset).length === 0) continue;
    for (const path of Object.keys($unset)) {
      console.log(`[migration] tenant ${tenant.tenantId}: removed unreadable ${path}`);
    }
    await tenants.updateOne(
      { _id: tenant._id },
      {
        ...(Object.keys($set).length && { $set }),
        ...(Object.keys($unset).length && { $unset }),
      },
    );
    changed++;
  }
  if (changed > 0) console.log(`[migration] typed the settings of ${changed} tenants`);
}

/** Nothing to do: the values as they were stored before are not kept, so they cannot come back. */
export async function down(_db?: Db): Promise<void> {
  console.log('[migration] tenant settings keep their types: the old values are not restored');
}
