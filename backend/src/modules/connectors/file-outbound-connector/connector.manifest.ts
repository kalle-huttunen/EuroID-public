import { ConnectorManifest } from '../plugin/connector-manifest.interface';
import { FileOutboundConnectorModule } from './file-outbound.module';

export const fileOutboundManifest: ConnectorManifest = {
  id: 'file-outbound',
  name: 'File Outbound',
  version: '1.0.0',
  description:
    'Dev connector: appends provisioning intent (user + intent) to a local JSONL file. Same user provisioned twice = two lines (append-only).',
  icon: 'FileTextOutlined',
  capabilities: ['provision', 'healthCheck'],
  configSchema: [
    {
      key: 'outputFilePath',
      label: 'Output File Path',
      type: 'text',
      required: true,
      placeholder: './provisioning-log.jsonl',
      description:
        'Path to the JSONL file inside FILE_OUTBOUND_ALLOWED_DIR (relative paths resolve against it); a path outside it is refused.',
    },
  ],
  module: FileOutboundConnectorModule,
};
