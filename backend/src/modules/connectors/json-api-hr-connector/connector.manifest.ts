import { ConnectorManifest } from '../plugin/connector-manifest.interface';
import { JsonApiHrConnectorModule } from './json-api-hr.module';

export const jsonApiHrManifest: ConnectorManifest = {
  id: 'json-api-hr',
  name: 'JSON API HR',
  version: '1.0.0',
  description:
    'Import user data from HTTP endpoints returning JSON arrays. Supports { data: [...] } or { users: [...] } shapes.',
  icon: 'ApiOutlined',
  capabilities: ['ingest', 'healthCheck'],
  configSchema: [
    {
      key: 'url',
      label: 'API URL',
      type: 'text',
      required: true,
      placeholder: 'https://api.example.com/users',
      description: 'HTTP endpoint returning JSON array',
    },
    {
      key: 'authType',
      label: 'Authentication',
      type: 'select',
      required: false,
      options: [
        { label: 'None', value: 'none' },
        { label: 'Bearer token', value: 'bearer' },
        { label: 'Custom header', value: 'header' },
      ],
      defaultValue: 'none',
      description: 'How to authenticate to the API. Not used for local file paths.',
    },
    {
      key: 'bearerToken',
      label: 'Bearer Token',
      type: 'password',
      required: false,
      description: 'Sent as "Authorization: Bearer <token>" when Authentication is "Bearer token".',
    },
    {
      key: 'authHeaderName',
      label: 'Auth Header Name',
      type: 'text',
      required: false,
      placeholder: 'X-API-Key',
      description: 'Header name when Authentication is "Custom header".',
    },
    {
      key: 'authHeaderSecret',
      label: 'Auth Header Value',
      type: 'password',
      required: false,
      description: 'Header value when Authentication is "Custom header". Stored encrypted.',
    },
    {
      key: 'responsePath',
      label: 'Response Path',
      type: 'text',
      required: false,
      placeholder: 'data',
      description:
        'Path to array in response (e.g. "data", "users"). Omit if response is a direct array.',
    },
    {
      key: 'sourceSystem',
      label: 'Source System Name',
      type: 'text',
      required: false,
      placeholder: 'json-api-hr',
      description: 'Used as sourceSystem in identity.sources',
    },
    {
      key: 'fieldMap',
      label: 'Field Map',
      type: 'json',
      required: false,
      placeholder: '{"emp_id": "sourceUserId", "email": "email", "staff_no": "employeeNumber"}',
      description:
        'JSON object: JSON property name → the field it fills. Replaces the default map; leave empty to use ' +
        'it. Fields: sourceUserId, email (required), firstName, lastName, jobTitle, ' +
        'departmentName, employeeId, employeeNumber, employmentType, mobilePhone, location, ' +
        'startDate, endDate, hrStatus, or customAttributes.<key>.',
      validationFn: 'hrFieldMap',
    },
    {
      key: 'syncIntervalHours',
      label: 'Sync Interval',
      type: 'select',
      required: false,
      options: [
        { label: 'Manual only', value: '0' },
        { label: 'Every hour', value: '1' },
        { label: 'Every 6 hours', value: '6' },
        { label: 'Every 12 hours', value: '12' },
        { label: 'Every 24 hours', value: '24' },
      ],
      defaultValue: '0',
      description: 'How often to automatically pull data from this connector',
    },
  ],
  module: JsonApiHrConnectorModule,
};
