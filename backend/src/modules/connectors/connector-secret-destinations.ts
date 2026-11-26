/**
 * Where a connector sends its stored secrets: per connector id, the config fields that decide
 * the host, port or transport a secret goes to, or the account it is presented as. A health check
 * on form values (POST /connectors/:name/health-check, ConnectorConfigService.withStoredSecrets)
 * puts a stored secret in place of its mask only while every one of these fields equals the saved
 * config: otherwise any caller of the check could have the API send the tenant's secret to a host
 * of their choosing. A connector not listed here counts every field that is not a secret.
 */
export const SECRET_DESTINATION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // The bind DN is the account the password is sent as; useLdaps false would send it in clear
  ad: ['host', 'port', 'useLdaps', 'serviceAccount'],
  // The client secret goes to the token endpoint of `tenantId`, for `clientId`
  'entra-id': ['tenantId', 'clientId'],
  scim: ['baseUrl', 'oauth2TokenUrl', 'username', 'clientId'],
  'json-api-hr': ['url'],
  okta: ['orgUrl'],
  servicenow: ['instanceUrl', 'clientId', 'username'],
  // The token always goes to api.github.com; the organization only names a path there
  github: [],
  // The service account key always goes to Google; the sheet id only names the sheet
  'google-sheets': [],
  // The webhook URL is the secret itself
  'discord-webhook': [],
  'csv-hr': [],
  'file-outbound': [],
};

/** A config value as stored text: a form may send a port as a number or a flag as a boolean. */
const asText = (value: unknown): string => (value == null ? '' : String(value));

/**
 * The destination fields of `config` (form values) that differ from `saved`, the config the
 * stored secrets belong to. A field missing on one side and set on the other differs.
 */
export function changedSecretDestinations(
  connectorName: string,
  config: Record<string, unknown>,
  saved: Record<string, unknown>,
  isSecretKey: (key: string) => boolean,
): string[] {
  const fields =
    SECRET_DESTINATION_FIELDS[connectorName] ??
    [...new Set([...Object.keys(saved), ...Object.keys(config)])].filter((k) => !isSecretKey(k));
  return fields.filter((field) => asText(config[field]) !== asText(saved[field]));
}
