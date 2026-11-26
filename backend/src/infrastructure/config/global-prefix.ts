import type { GlobalPrefixOptions } from '@nestjs/common/interfaces';

/**
 * Global HTTP route prefix, applied once in main.ts via app.setGlobalPrefix().
 * Controllers must not repeat it in @Controller(): that yields /api/v1/api/v1/... routes.
 */
export const API_GLOBAL_PREFIX = 'api/v1';

/** SCIM 2.0 endpoints are served at /scim/v2 (RFC 7644 clients expect that base path). */
export const API_GLOBAL_PREFIX_OPTIONS: GlobalPrefixOptions = {
  exclude: ['scim/v2/(.*)'],
};
