import { BadRequestException } from '@nestjs/common';

/** Whitelist of filter keys allowed for identity user-supplied filters. tenantId and deletedAt are excluded. */
export const IDENTITY_ALLOWED_FILTER_KEYS = [
  'email',
  'profile.email',
  'firstName',
  'profile.firstName',
  'lastName',
  'profile.lastName',
  'departmentName',
  'profile.departmentName',
  'status',
  'jobTitle',
  'profile.jobTitle',
  'location',
  'profile.location',
  'employmentType',
  'profile.employmentType',
  'sourceSystem',
] as const;

export type IdentityAllowedFilterKey = (typeof IDENTITY_ALLOWED_FILTER_KEYS)[number];

/**
 * Validates that filter keys are in the allowed whitelist and do not start with $.
 * Filter values must be primitives (string, number, boolean, null) or arrays of primitives.
 * Throws BadRequestException on invalid keys or non-primitive object values.
 */
export function validateFilterKeys(
  filter: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  for (const key of Object.keys(filter)) {
    if (key.startsWith('$') || !allowedKeys.includes(key)) {
      throw new BadRequestException(`Invalid filter key: ${key}`);
    }
    const val = filter[key];
    rejectNonPrimitiveFilterValue(val, key);
    rejectOperators(val);
  }
}

/**
 * Rejects non-primitive filter values. Allowed: string, number, boolean, null,
 * or arrays of primitives. Plain objects are disallowed to prevent operator injection.
 */
function rejectNonPrimitiveFilterValue(value: unknown, key: string): void {
  if (
    value == null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item != null && typeof item === 'object') {
        throw new BadRequestException(
          `Filter value for "${key}" must be a primitive or array of primitives`,
        );
      }
    }
    return;
  }
  if (typeof value === 'object') {
    throw new BadRequestException(
      `Filter value for "${key}" must be a primitive or array of primitives`,
    );
  }
}

const MAX_RECURSION_DEPTH = 8;

/**
 * Recursively rejects MongoDB $ operators in values at any depth.
 * Recurse into array elements. Depth cap bounds ABAC condition complexity.
 */
export function rejectOperators(value: unknown, depth = 0): void {
  if (depth > MAX_RECURSION_DEPTH) {
    throw new BadRequestException('Filter nesting too deep');
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) rejectOperators(item, depth + 1);
    return;
  }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    if (k.startsWith('$')) {
      throw new BadRequestException('Query operators not allowed in filter values');
    }
    rejectOperators((value as Record<string, unknown>)[k], depth + 1);
  }
}
