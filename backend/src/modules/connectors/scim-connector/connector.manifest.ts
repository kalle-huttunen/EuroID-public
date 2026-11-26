import { ConnectorManifest } from '../plugin/connector-manifest.interface';
import { ScimConnectorModule } from './scim.module';
import { SCIMService } from './scim.service';
import { ScimActivities } from '../../../activities/scim.activities';

export const scimManifest: ConnectorManifest = {
  id: 'scim',
  name: 'SCIM 2.0 (Generic)',
  version: '1.0.0',
  description: 'Generic SCIM 2.0 connector — provision to any SCIM-compliant SaaS app',
  icon: 'ApiOutlined',
  capabilities: ['discover', 'provision', 'deprovision', 'healthCheck'],
  configSchema: [
    {
      key: 'baseUrl',
      label: 'SCIM Base URL',
      type: 'text',
      required: true,
      placeholder: 'https://api.example.com/scim/v2',
    },
    {
      key: 'authType',
      label: 'Authentication Type',
      type: 'select',
      required: true,
      options: [
        { label: 'Bearer Token', value: 'bearer' },
        { label: 'Basic Auth', value: 'basic' },
        { label: 'OAuth2 Client Credentials', value: 'oauth2' },
      ],
    },
    {
      key: 'bearerToken',
      label: 'Bearer Token',
      type: 'password',
      required: false,
      description: 'Required when auth type is Bearer Token',
    },
    {
      key: 'username',
      label: 'Username',
      type: 'text',
      required: false,
      description: 'Required when auth type is Basic Auth',
    },
    {
      key: 'password',
      label: 'Password',
      type: 'password',
      required: false,
      description: 'Required when auth type is Basic Auth',
    },
    {
      key: 'oauth2TokenUrl',
      label: 'OAuth2 Token URL',
      type: 'text',
      required: false,
      placeholder: 'https://auth.example.com/oauth/token',
      description: 'Required when auth type is OAuth2',
    },
    {
      key: 'clientId',
      label: 'Client ID',
      type: 'text',
      required: false,
      description: 'Required when auth type is OAuth2',
    },
    {
      key: 'clientSecret',
      label: 'Client Secret',
      type: 'password',
      required: false,
      description: 'Required when auth type is OAuth2',
    },
    {
      key: 'deprovisionStrategy',
      label: 'Deprovision Strategy',
      type: 'select',
      required: false,
      description: 'How to handle user deprovisioning',
      defaultValue: 'deactivate',
      options: [
        { label: 'Deactivate (set active=false)', value: 'deactivate' },
        { label: 'Delete user', value: 'delete' },
      ],
    },
  ],
  taskQueue: 'provisioning-scim',
  module: ScimConnectorModule,
  serviceClass: SCIMService,
  activityClass: ScimActivities,
  activityBindings: {
    provisionUserToScim: 'provisionUserToScim',
    deprovisionScimUser: 'deprovisionScimUser',
    discoverScimEntitlements: 'discoverScimEntitlements',
    checkScimHealth: 'checkScimHealth',
    setScimUserActive: 'setScimUserActive',
  },
};

// ── TASK 107 RECAP ──
// Added: serviceClass: SCIMService — enables PluginRegistryService to call validateCapabilities.
