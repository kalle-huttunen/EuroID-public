import { ConnectorManifest } from '../plugin/connector-manifest.interface';
import { GoogleSheetsConnectorModule } from './google-sheets.module';

export const googleSheetsManifest: ConnectorManifest = {
  id: 'google-sheets',
  name: 'Google Sheets',
  version: '1.0.0',
  description:
    'Dev connector: appends user rows (Email, FirstName, LastName, JobTitle, Department, ProvisionedAt) to a Google Sheet on provision.',
  icon: 'TableOutlined',
  capabilities: ['provision', 'healthCheck'],
  configSchema: [
    {
      key: 'sheetId',
      label: 'Sheet ID',
      type: 'text',
      required: true,
      placeholder: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
      description: 'Google Sheet ID from URL (/d/SHEET_ID/edit)',
    },
    {
      key: 'serviceAccountJson',
      label: 'Service Account JSON',
      type: 'password',
      required: true,
      placeholder: '{"type":"service_account",...}',
      description:
        'Full JSON of service account credentials. Create in GCP: enable Sheets API, create service account, share sheet with client_email.',
    },
    {
      key: 'sheetName',
      label: 'Worksheet Name',
      type: 'text',
      required: false,
      placeholder: 'Sheet1',
      description: 'Worksheet name (optional, default: first sheet)',
      defaultValue: '',
    },
  ],
  module: GoogleSheetsConnectorModule,
};
