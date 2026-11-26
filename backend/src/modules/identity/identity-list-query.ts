/**
 * GET /identity query parameters (IdentityController.findAll): the whitelisted JSON `filter`, a
 * text search `q` and `includeDeleted` (offboarded, soft-deleted identities too). The route is a
 * viewer's; `includeDeleted` needs operator, like the GDPR export and erasure that take those
 * identities. A caller can fix every refusal here: 400 for a bad value, 403 for the role.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { rolesGrant } from '@infrastructure/auth/roles.guard';
import { validateFilterKeys, IDENTITY_ALLOWED_FILTER_KEYS } from '@shared/utils/filter-validator';
import { normalizeEmail } from '@shared/utils/email';
import { IDENTITY_SEARCH_MAX_LENGTH } from './identity-search';

const IdentityListQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(IDENTITY_SEARCH_MAX_LENGTH, `q takes at most ${IDENTITY_SEARCH_MAX_LENGTH} characters`)
    .optional(),
  includeDeleted: z
    .enum(['true', 'false'], { message: 'includeDeleted takes true or false' })
    .optional(),
});

export interface IdentityListQuery {
  filter?: Record<string, unknown>;
  search?: string;
  includeDeleted: boolean;
}

function parseFilter(filterParam: string | undefined): Record<string, unknown> | undefined {
  if (!filterParam?.trim()) return undefined;
  let filter: unknown;
  try {
    filter = JSON.parse(filterParam);
  } catch {
    throw new BadRequestException('Invalid filter: invalid JSON');
  }
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw new BadRequestException('Invalid filter: must be a JSON object');
  }
  validateFilterKeys(filter as Record<string, unknown>, IDENTITY_ALLOWED_FILTER_KEYS);
  return filter as Record<string, unknown>;
}

/**
 * A whitelisted user filter (validateFilterKeys) as the query on identities: a bare key
 * (`status`) is the profile field (`profile.status`; the document root holds no profile field),
 * a list matches any of its values, and an email is compared as stored (lower-cased).
 */
export function identityFilterQuery(filter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filter).map(([key, value]) => {
      const path = key.startsWith('profile.') ? key : `profile.${key}`;
      const asStored = (v: unknown) =>
        path === 'profile.email' && typeof v === 'string' ? normalizeEmail(v) : v;
      return [path, Array.isArray(value) ? { $in: value.map(asStored) } : asStored(value)];
    }),
  );
}

/** The list query as the service takes it, or the refusal that says what to fix. */
export function parseIdentityListQuery(
  raw: { filter?: string; q?: string; includeDeleted?: string },
  callerRoles: readonly string[] | undefined,
): IdentityListQuery {
  const parsed = IdentityListQuerySchema.safeParse({
    q: raw.q,
    includeDeleted: raw.includeDeleted,
  });
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
  }
  const includeDeleted = parsed.data.includeDeleted === 'true';
  if (includeDeleted && !rolesGrant(callerRoles, 'operator')) {
    throw new ForbiddenException('includeDeleted=true needs the operator role or above');
  }
  return {
    filter: parseFilter(raw.filter),
    search: parsed.data.q || undefined,
    includeDeleted,
  };
}
