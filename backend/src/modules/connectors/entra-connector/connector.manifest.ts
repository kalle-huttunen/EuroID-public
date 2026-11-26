import { ConnectorManifest } from '../plugin/connector-manifest.interface';
import { EntraConnectorModule } from './entra.module';
import { EntraService } from './entra.service';
import { EntraActivities } from '../../../activities/entra.activities';

export const entraManifest: ConnectorManifest = {
  id: 'entra-id',
  name: 'Microsoft Entra ID',
  version: '1.0.0',
  description: 'Azure AD / Entra ID — User provisioning, group management, license assignment',
  icon: 'WindowsOutlined',
  capabilities: [
    'discover',
    'provision',
    'deprovision',
    'healthCheck',
    'reconciliation',
    'credentialManagement',
  ],
  configSchema: [
    {
      key: 'tenantId',
      label: 'Tenant ID',
      type: 'text',
      required: true,
      placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    },
    { key: 'clientId', label: 'Application (Client) ID', type: 'text', required: true },
    { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true },
    {
      key: 'defaultDomain',
      label: 'Default Domain',
      type: 'text',
      required: false,
      placeholder: 'contoso.com',
      description: 'M365-verified domain for UPN generation',
    },
    { key: 'defaultLicense', label: 'Default License SKU', type: 'text', required: false },
    {
      key: 'usageLocation',
      label: 'Usage Location',
      type: 'text',
      required: false,
      placeholder: 'FI',
      description: 'ISO 3166 country code (required for license assignment)',
    },
    {
      key: 'syncIntervalHours',
      label: 'Discovery Sync Interval',
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
      description: 'How often to automatically discover entitlements (groups, licenses)',
    },
  ],
  taskQueue: 'provisioning-entra',
  module: EntraConnectorModule,
  serviceClass: EntraService,
  activityClass: EntraActivities,
  activityBindings: {
    isEntraConfigured: 'isEntraConfigured',
    checkEntraHealth: 'checkEntraHealth',
    provisionUserToEntra: 'provisionUserToEntra',
    disableEntraUser: 'disableEntraUser',
    enableEntraUser: 'enableEntraUser',
    deleteUser: 'deleteUser',
    discoverEntitlements: 'discoverEntitlements',
    validateUpn: 'validateUpn',
    validateBulkUpns: 'validateBulkUpns',
    resolveUpnForUser: 'resolveUpnForUser',
  },
};

// ── TASK 107 RECAP ──
// Added: serviceClass: EntraService — enables PluginRegistryService to call validateCapabilities.
