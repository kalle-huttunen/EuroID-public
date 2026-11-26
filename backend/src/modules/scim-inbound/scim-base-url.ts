import type { Request } from 'express';

/**
 * The base of the links SCIM answers carry (`meta.location`, member `$ref`): APP_BASE_URL when
 * it is set, else the request's protocol and Host header as Express reads them. Express takes
 * X-Forwarded-Proto into `req.protocol` only from a proxy TRUST_PROXY trusts; the forwarded
 * headers are never read here directly, so a caller cannot choose the links' host through them.
 */
export function scimBaseUrl(req: Request): string {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL.replace(/\/$/, '');
  }
  const host = req.get('host') ?? process.env.API_PUBLIC_HOST ?? 'localhost:3001';
  return `${req.protocol}://${host}`;
}
