/**
 * PII masking for identity API responses.
 *
 * Identity responses (IdentityController, via MaskPiiInterceptor) carry the fields in
 * PII_FIELDS masked. The clear value leaves the API only through
 * POST /identity/:id/pii/reveal, which writes the PII_REVEALED audit entry in the same
 * request (identity-pii.service.ts). Internal callers of IdentityService are unaffected:
 * masking happens at the HTTP boundary only.
 */

import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** Profile fields treated as personal contact data. Reveal allow-list. */
export const PII_FIELDS = ['personalEmail', 'mobilePhone', 'workPhone', 'officeExtension'] as const;
export type PiiField = (typeof PII_FIELDS)[number];
export const PiiFieldSchema = z.enum(PII_FIELDS);

export const PII_MASK_CHAR = '•';

const PII_FIELD_SET: ReadonlySet<string> = new Set(PII_FIELDS);
const MASK = PII_MASK_CHAR.repeat(3);
/** Trailing phone digits left visible, only when at least as many digits are masked. */
const PHONE_VISIBLE_DIGITS = 4;
/** International prefix followed by a separator, e.g. "+358 " in "+358 40 123 4567". */
const COUNTRY_CODE = /^\+\d{1,3}(?=[\s-])/;
const DIGIT = /\d/;
const PHONE_SEPARATOR = /[\s().+-]/;

/**
 * matti@example.com -> m•••@example.com: first character and the domain stay visible. Also for
 * emails outside identity responses that must not carry the address (dead letters, events, logs).
 * A value that is not a string (an untyped document without the field) masks to "•••": a log
 * line must not throw.
 */
export function maskEmail(value: string): string {
  if (typeof value !== 'string') return MASK;
  const at = value.lastIndexOf('@');
  if (at < 1) return MASK;
  return `${value[0]}${MASK}${value.slice(at)}`;
}

const EMAIL_VALUE = /^[^\s@]+@[^\s@]+$/;

/**
 * Copy of `values` with every string value that is an email address masked (maskEmail): the
 * before-values identity.updated and identity.move_requested carry (managerEmail), which reach
 * the audit log, the analytics index and the tenant websocket.
 */
export function maskEmailValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string' && EMAIL_VALUE.test(value) ? maskEmail(value) : value,
    ]),
  );
}

/** octocat -> o•••: a login (e.g. a GitHub login) keeps its first character, like maskEmail. */
export function maskLogin(value: string): string {
  return value ? `${value[0]}${MASK}` : MASK;
}

/** +358 40 123 4567 -> +358 •• ••• 4567. Letters and short numbers are masked entirely. */
function maskPhone(value: string): string {
  const prefix = COUNTRY_CODE.exec(value)?.[0] ?? '';
  const rest = value.slice(prefix.length);
  const digitCount = rest.split('').filter((ch) => DIGIT.test(ch)).length;
  let visible = digitCount >= 2 * PHONE_VISIBLE_DIGITS ? PHONE_VISIBLE_DIGITS : 0;
  const out: string[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const ch = rest[i];
    if (DIGIT.test(ch)) {
      out.push(visible > 0 ? ch : PII_MASK_CHAR);
      visible--;
    } else {
      out.push(PHONE_SEPARATOR.test(ch) ? ch : PII_MASK_CHAR);
    }
  }
  return prefix + out.reverse().join('');
}

/** 4567 -> ••••. Extensions are short, so nothing stays visible. */
function maskExtension(value: string): string {
  return value.replace(/\S/g, PII_MASK_CHAR);
}

/** Masked form of one PII value. Empty values stay empty; non-string values become "•••". */
export function maskPiiValue(field: PiiField, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return value;
  if (typeof value !== 'string' && typeof value !== 'number') return MASK;
  const text = String(value);
  switch (field) {
    case 'personalEmail':
      return maskEmail(text);
    case 'mobilePhone':
    case 'workPhone':
      return maskPhone(text);
    case 'officeExtension':
      return maskExtension(text);
  }
}

function toPlainObject(node: object): Record<string, unknown> | null {
  const proto: unknown = Object.getPrototypeOf(node);
  if (proto === Object.prototype || proto === null) return node as Record<string, unknown>;
  // Hydrated Mongoose document: walk its plain form. Dates, ObjectIds etc. pass through.
  const toObject = (node as { toObject?: unknown }).toObject;
  if (typeof toObject === 'function') {
    return (toObject as () => Record<string, unknown>).call(node);
  }
  return null;
}

/**
 * Keys outside PII_FIELDS that carry a phone number in event and connector payloads: phone,
 * homePhone, telephoneNumber (AD), businessPhones (Entra), phoneNumbers (SCIM), mobile (LDAP),
 * fax, pager.
 */
const PHONE_LIKE_KEY = /phone|^(mobile|fax|pager|tel)(number)?$/i;

/**
 * Copy of a response body with every PII_FIELDS key masked, at any depth
 * (flat profile, onion `profile`, `sources[].rawData`, wrapper objects).
 */
export function maskPiiDeep<T>(body: T): T {
  return maskNode(body, false) as T;
}

/**
 * maskPiiDeep that also masks every value under a phone-like key the way mobilePhone is masked.
 * For payloads that are not identity responses (dead letters), whose phone fields carry any name.
 * Identity responses keep maskPiiDeep: their reveal covers PII_FIELDS only.
 */
export function maskPiiAndPhonesDeep<T>(body: T): T {
  return maskNode(body, true) as T;
}

function maskNode(node: unknown, phoneLikeKeys: boolean): unknown {
  if (Array.isArray(node)) return node.map((item) => maskNode(item, phoneLikeKeys));
  if (node === null || typeof node !== 'object') return node;
  const plain = toPlainObject(node);
  if (!plain) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plain)) {
    if (PII_FIELD_SET.has(key)) out[key] = maskPiiValue(key as PiiField, value);
    else if (phoneLikeKeys && PHONE_LIKE_KEY.test(key)) out[key] = maskPhoneLeaves(value);
    else out[key] = maskNode(value, phoneLikeKeys);
  }
  return out;
}

/** Every string and number under a phone-like key: "+358...", ["+358..."], [{ value, type }]. */
function maskPhoneLeaves(node: unknown): unknown {
  if (typeof node === 'string' || typeof node === 'number') {
    return maskPiiValue('mobilePhone', node);
  }
  if (Array.isArray(node)) return node.map(maskPhoneLeaves);
  if (node === null || typeof node !== 'object') return node;
  const plain = toPlainObject(node);
  if (!plain) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plain)) out[key] = maskPhoneLeaves(value);
  return out;
}

/**
 * PII fields of a write body that carry a masked value, e.g. a GET response sent back
 * in a PATCH. Writing one would replace the stored value with its mask.
 */
export function findMaskedPiiFields(body: unknown): PiiField[] {
  if (body === null || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  return PII_FIELDS.filter((field) => {
    const value = record[field];
    return typeof value === 'string' && value.includes(PII_MASK_CHAR);
  });
}

/** Refuses a write that would replace stored PII with its mask (a GET body sent back). */
export function rejectMaskedPii(body: unknown): void {
  const masked = findMaskedPiiFields(body);
  if (masked.length > 0) {
    throw new BadRequestException(
      `Masked values cannot be saved: ${masked.join(', ')}. Reveal the field before editing it.`,
    );
  }
}
