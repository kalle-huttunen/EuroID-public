import type { ConnectorManifest } from './plugin/connector-manifest.interface';
import { parseHrFieldMap } from './hr/hr-field-map';
import { feedReadMethod } from './json-api-hr-connector/json-api-hr.client';

/** ConfigField.validationFn of an HR column or field map (hr/hr-field-map.ts). */
export const HR_FIELD_MAP_RULE = 'hrFieldMap';

/**
 * The config to store: each value whose manifest field names a rule the API runs is checked (a
 * 400 names the entry that is wrong) and written in its canonical form. A JSON API HR `method`
 * other than GET is refused (feedReadMethod). A map is stored as compact
 * JSON text, a blank map as '' (the connector's default map). Other values are kept as sent.
 */
export function checkedConnectorConfig(
  manifest: ConnectorManifest | undefined,
  config: Record<string, string>,
): Record<string, string> {
  // JSON API HR reads its feed with GET only (400 otherwise, as at ingest)
  if (manifest?.id === 'json-api-hr' && 'method' in config) feedReadMethod(config.method);
  let checked = config;
  for (const field of manifest?.configSchema ?? []) {
    if (field.validationFn !== HR_FIELD_MAP_RULE || !(field.key in config)) continue;
    const map = parseHrFieldMap(config[field.key], field.key);
    checked = { ...checked, [field.key]: map ? JSON.stringify(map) : '' };
  }
  return checked;
}
