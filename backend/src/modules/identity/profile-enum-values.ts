import { EmploymentType, UserPriority, UserStatus } from '@shared/dtos/standard-user.dto';

/** The profile fields stored as an enum (identity.schema.ts) and the values each takes. */
const PROFILE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  status: Object.values(UserStatus),
  employmentType: Object.values(EmploymentType),
  priority: Object.values(UserPriority),
};

/** A source value an enum field of the profile cannot take. */
export const NOT_A_PROFILE_VALUE = Symbol('not a profile value');

/**
 * The value a source record's `value` gives the profile field `key`. A field that is no enum
 * takes it as it is. An enum field (status, employmentType, priority) takes the enum value it
 * names in any case, with spaces or hyphens for underscores ("active", "full time"), as the HR
 * connectors normalise an employment type; a value that names none is NOT_A_PROFILE_VALUE, so
 * reconcile leaves it out instead of failing the save. HR ingest validates the row, so such a
 * value comes only from a record stored another way (a seed, a migration, an old version).
 */
export function profileValue(key: string, value: unknown): unknown {
  const allowed = PROFILE_ENUMS[key];
  if (!allowed) return value;
  if (typeof value !== 'string') return NOT_A_PROFILE_VALUE;
  if (allowed.includes(value)) return value;
  const named = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  return allowed.includes(named) ? named : NOT_A_PROFILE_VALUE;
}
