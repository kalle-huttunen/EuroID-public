import { ConnectorManifest } from '../plugin/connector-manifest.interface';
import { OktaConnectorModule } from './okta.module';
import { OktaService } from './okta.service';
import { OktaActivities } from '../../../activities/okta.activities';

export const oktaManifest: ConnectorManifest = {
  id: 'okta',
  name: 'Okta Identity Cloud',
  version: '1.0.0',
  description: 'Okta — Native API connector for user provisioning, group/app assignments',
  icon: 'CloudOutlined',
  capabilities: ['discover', 'provision', 'deprovision', 'healthCheck'],
  configSchema: [
    {
      key: 'orgUrl',
      label: 'Okta Org URL',
      type: 'text',
      required: true,
      placeholder: 'https://dev-123456.okta.com',
      description: 'Your Okta organization URL',
    },
    {
      key: 'apiToken',
      label: 'API Token',
      type: 'password',
      required: true,
      description: 'Okta API token (SSWS). Create in Security > API > Tokens.',
    },
    {
      key: 'defaultGroupId',
      label: 'Default Group ID',
      type: 'text',
      required: false,
      placeholder: '00g1234567890abcdef',
      description: 'Okta group ID to assign new users to by default',
    },
    {
      key: 'deprovisionStrategy',
      label: 'Deprovision Strategy',
      type: 'select',
      required: false,
      description: 'What offboarding does to the Okta user',
      defaultValue: 'deactivate',
      options: [
        { label: 'Deactivate', value: 'deactivate' },
        { label: 'Deactivate, then delete', value: 'delete' },
      ],
    },
  ],
  taskQueue: 'provisioning-okta',
  module: OktaConnectorModule,
  serviceClass: OktaService,
  activityClass: OktaActivities,
  activityBindings: {
    checkOktaHealth: 'checkOktaHealth',
    provisionUserToOkta: 'provisionUserToOkta',
    disableOktaUser: 'disableOktaUser',
    deprovisionOktaUser: 'deprovisionOktaUser',
    setOktaUserEnabled: 'setOktaUserEnabled',
    discoverOktaEntitlements: 'discoverOktaEntitlements',
  },
};
