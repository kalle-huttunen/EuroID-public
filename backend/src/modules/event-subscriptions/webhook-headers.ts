import { BadRequestException } from '@nestjs/common';

/**
 * Rules for a webhook subscription's custom headers. Applied when a subscription is saved (Zod)
 * and again before each delivery, because a subscription stored before the rules may break them.
 * A custom header must not replace what EuroID or the HTTP client sets on every delivery, and its
 * name must fit the stored Map (MongoDB: no ".", no leading "$").
 */

/** RFC 9110 token: the characters an HTTP header name may hold. */
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** What Node sends in a header value: tab, visible ASCII and obs-text. No CR or LF. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Set by EuroID or the HTTP client on every delivery. */
const RESERVED_NAMES = new Set(['host', 'content-type', 'content-length']);

/** Prefix of the headers EuroID signs a delivery with (X-EuroID-Signature, -Event, -Delivery). */
const EUROID_PREFIX = 'x-euroid-';

/** Longest custom header value. */
export const WEBHOOK_HEADER_VALUE_MAX = 2000;

/** Why a custom header name cannot be used, or undefined when it can. */
export function webhookHeaderNameProblem(name: string): string | undefined {
  if (!HTTP_TOKEN.test(name)) return 'is not a valid HTTP header name';
  if (name.includes('.') || name.startsWith('$')) return 'cannot contain "." or start with "$"';
  const lower = name.toLowerCase();
  if (RESERVED_NAMES.has(lower) || lower.startsWith(EUROID_PREFIX)) {
    return 'is set by EuroID on every delivery';
  }
  return undefined;
}

/** Why a custom header value cannot be sent, or undefined when it can. Never quotes the value. */
export function webhookHeaderValueProblem(value: string): string | undefined {
  if (value.length > WEBHOOK_HEADER_VALUE_MAX) {
    return `is longer than ${WEBHOOK_HEADER_VALUE_MAX} characters`;
  }
  if (!HEADER_VALUE.test(value))
    return 'contains a line break or another character HTTP does not allow';
  return undefined;
}

/** A subscription's stored headers as entries: a Mongoose Map, or a plain object from lean(). */
export function headerEntries(
  headers: Map<string, string> | Record<string, string> | null | undefined,
): Array<[string, string]> {
  if (!headers) return [];
  return headers instanceof Map ? [...headers.entries()] : Object.entries(headers);
}

/**
 * The custom headers after an edit. The edit names every header the subscription keeps; one sent
 * as null keeps its stored value (the API never answers values, so a client cannot resend them),
 * and a stored header the edit leaves out is removed.
 */
export function headersAfterEdit(
  stored: Map<string, string> | Record<string, string> | null | undefined,
  edit: Record<string, string | null>,
): Record<string, string> {
  const current = new Map(headerEntries(stored));
  return Object.fromEntries(
    Object.entries(edit).map(([name, value]) => {
      const kept = value ?? current.get(name);
      if (kept === undefined) {
        throw new BadRequestException(
          `Header ${name} has no stored value to keep: send its value.`,
        );
      }
      return [name, kept];
    }),
  );
}
