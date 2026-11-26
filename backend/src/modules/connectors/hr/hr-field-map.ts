import { BadRequestException } from '@nestjs/common';
import { HR_STATUS_FIELD } from './hr-lifecycle-fields';
import { CUSTOM_ATTRIBUTE_PREFIX } from './hr-custom-attributes';

/**
 * The column map of CSV HR (`config.columnMap`) and the field map of JSON API HR
 * (`config.fieldMap`): source column or JSON key → the field it fills. Connector config values are
 * strings (connector-config.dto.ts), so the API stores a map as JSON object text; a config written
 * by code may hold the object itself. A map replaces the connector's default map.
 */

/** The fields both HR connectors' mapping reads (csv-hr.service.ts, json-api-hr.service.ts). */
export const HR_FIELD_MAP_TARGETS: readonly string[] = [
  'sourceUserId',
  'email',
  'firstName',
  'lastName',
  'jobTitle',
  'departmentName',
  'employeeId',
  'employeeNumber',
  'employmentType',
  'mobilePhone',
  'location',
  'startDate',
  'endDate',
  HR_STATUS_FIELD,
];

/** Names a lookup by key must never take (they reach Object.prototype). */
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
/** A custom attribute key: a plain name, as long as StandardUserDto allows. */
const CUSTOM_ATTRIBUTE_KEY = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_SOURCE_NAME_LENGTH = 200;

/** True when `target` is a field the HR mapping fills. */
function isMapTarget(target: string): boolean {
  if (HR_FIELD_MAP_TARGETS.includes(target)) return true;
  if (!target.startsWith(CUSTOM_ATTRIBUTE_PREFIX)) return false;
  const key = target.slice(CUSTOM_ATTRIBUTE_PREFIX.length);
  return CUSTOM_ATTRIBUTE_KEY.test(key) && !FORBIDDEN_NAMES.has(key);
}

const refuse = (configKey: string, reason: string) =>
  new BadRequestException(`config.${configKey}: ${reason}`);

/**
 * The map in `raw` (JSON object text or an object), checked; undefined when no map is set (absent
 * or blank), so the connector uses its default map. Throws a 400 naming the entry that is wrong.
 */
export function parseHrFieldMap(
  raw: unknown,
  configKey: string,
): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return undefined;
    try {
      value = JSON.parse(raw);
    } catch {
      throw refuse(configKey, 'not valid JSON. Write an object such as {"Email": "email"}.');
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw refuse(configKey, 'must be a JSON object such as {"Email": "email"}.');
  }

  const map: Record<string, string> = {};
  for (const [source, target] of Object.entries(value as Record<string, unknown>)) {
    const name = source.trim();
    if (!name) throw refuse(configKey, 'a key is empty: name the source column or key.');
    if (name.length > MAX_SOURCE_NAME_LENGTH || FORBIDDEN_NAMES.has(name)) {
      throw refuse(configKey, `the key "${name.slice(0, 40)}" cannot be used.`);
    }
    if (typeof target !== 'string' || !isMapTarget(target.trim())) {
      throw refuse(
        configKey,
        `"${name}" maps to ${typeof target === 'string' ? `"${target}"` : `a ${typeof target}`}, ` +
          'which is not a field the HR mapping ' +
          `fills. Use one of ${HR_FIELD_MAP_TARGETS.join(', ')} or ` +
          `${CUSTOM_ATTRIBUTE_PREFIX}<key> (letters, digits, _ and -).`,
      );
    }
    map[source] = target.trim(); // the column or key as written: a lookup is exact
  }
  if (!Object.values(map).includes('email')) {
    throw refuse(configKey, 'map a column or key to email: a row without an email is skipped.');
  }
  return map;
}
