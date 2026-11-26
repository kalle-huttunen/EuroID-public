import { format } from 'winston';

/**
 * Keys whose value is personal data or a secret, compared normalized (normalizeKey): any casing,
 * with or without spaces and punctuation, so `firstName`, `First Name`, `FIRST_NAME` and the
 * column names of HR files (`E-mail`, `EmpID`) all match.
 */
const PII_FIELDS = new Set(
  [
    'firstName',
    'lastName',
    'name',
    'email',
    'personalEmail',
    'managerEmail',
    'phone',
    'mobilePhone',
    'workPhone',
    'socialSecurityNumber',
    'homeAddress',
    'address',
    'dateOfBirth',
    'nationalId',
    'taxId',
    'displayName',
    'clientSecret',
    'password',
    'apiKey',
    'token',
    'sourceUserId',
    'employeeId',
    'empId',
    'upn',
    'userPrincipalName',
    'homePhone',
    'businessPhone',
    'distinguishedName',
    'dn',
    'sAMAccountName',
  ].map(normalizeKey),
);

/** `First Name`, `first_name`, `firstName` -> `firstname`: lowercase letters and digits only. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const REDACTED = '[REDACTED]';

/**
 * Recursively walk an object and replace PII field values with [REDACTED].
 */
function redactPii(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactPii(item));
  }

  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (PII_FIELDS.has(normalizeKey(key))) {
        result[key] = REDACTED;
      } else {
        result[key] = redactPii(value);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Winston format that redacts PII fields from log output.
 * Use in production to avoid logging sensitive data.
 */
export function piiRedactFormat() {
  return format((info) => {
    const redacted = redactPii(info) as Record<string, unknown>;
    return redacted as import('logform').TransformableInfo;
  })();
}

/**
 * Returns a safe string representation of an object for logging.
 * Redacts PII fields before stringifying. Use instead of JSON.stringify when
 * logging objects that may contain user data (DTOs, rows, error payloads).
 */
export function safeLog(obj: unknown): string {
  try {
    const result = JSON.stringify(redactPii(obj));
    return result === undefined ? 'undefined' : result;
  } catch {
    return '[unable to serialize]';
  }
}
