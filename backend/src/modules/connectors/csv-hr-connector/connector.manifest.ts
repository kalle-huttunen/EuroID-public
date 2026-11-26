import { ConnectorManifest } from '../plugin/connector-manifest.interface';
import { CsvHrConnectorModule } from './csv-hr.module';

export const csvHrManifest: ConnectorManifest = {
  id: 'csv-hr',
  name: 'CSV HR',
  version: '1.0.0',
  description: 'Import user data from CSV files. Map columns to StandardUserDto fields.',
  icon: 'FileTextOutlined',
  capabilities: ['ingest', 'healthCheck'],
  configSchema: [
    {
      key: 'filePath',
      label: 'File Path',
      type: 'text',
      required: true,
      placeholder: '/path/to/employees.csv',
      description: 'Absolute or relative path to the CSV file',
    },
    {
      key: 'sourceSystem',
      label: 'Source System Name',
      type: 'text',
      required: false,
      placeholder: 'csv-hr',
      description: 'Used as sourceSystem in identity.sources (default: csv-hr)',
    },
    {
      key: 'columnMap',
      label: 'Column Map',
      type: 'json',
      required: false,
      placeholder:
        '{"Employee ID": "sourceUserId", "Email": "email", "Employee Number": "employeeNumber"}',
      description:
        'JSON object: CSV column header → the field it fills. Replaces the default map; leave empty to use ' +
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
  module: CsvHrConnectorModule,
};
