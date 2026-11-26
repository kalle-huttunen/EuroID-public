import { ConnectorManifest } from '../plugin/connector-manifest.interface';
import { GitHubConnectorModule } from './github.module';

export const githubManifest: ConnectorManifest = {
  id: 'github',
  name: 'GitHub',
  version: '1.0.0',
  description:
    'Dev connector: invites users to a GitHub organization (the GitHub account when the identity has a GitHub login, else the email); offboarding removes the membership, or cancels a pending email invitation.',
  icon: 'GithubOutlined',
  capabilities: ['provision', 'deprovision', 'healthCheck'],
  configSchema: [
    {
      key: 'personalAccessToken',
      label: 'Personal Access Token',
      type: 'password',
      required: true,
      placeholder: 'ghp_xxxx',
      description:
        'GitHub PAT with admin:org scope from an organization owner (invite, list and cancel invitations, remove members)',
    },
    {
      key: 'orgName',
      label: 'Organization Name',
      type: 'text',
      required: true,
      placeholder: 'my-company',
      description: 'GitHub organization slug',
    },
  ],
  module: GitHubConnectorModule,
};
