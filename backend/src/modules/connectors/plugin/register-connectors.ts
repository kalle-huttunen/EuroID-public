import { PluginRegistryService } from './plugin-registry.service';
import { entraManifest } from '../entra-connector/connector.manifest';
import { scimManifest } from '../scim-connector/connector.manifest';
import { csvHrManifest } from '../csv-hr-connector/connector.manifest';
import { jsonApiHrManifest } from '../json-api-hr-connector/connector.manifest';
import { fileOutboundManifest } from '../file-outbound-connector/connector.manifest';
import { discordWebhookManifest } from '../discord-webhook-connector/connector.manifest';
import { githubManifest } from '../github-connector/connector.manifest';
import { googleSheetsManifest } from '../google-sheets-connector/connector.manifest';
import { adManifest } from '../ad-connector/connector.manifest';
import { oktaManifest } from '../okta-connector/connector.manifest';
import { serviceNowManifest } from '../servicenow-connector/connector.manifest';

export function registerBuiltInConnectors(registry: PluginRegistryService): void {
  registry.register(entraManifest);
  registry.register(scimManifest);
  registry.register(csvHrManifest);
  registry.register(jsonApiHrManifest);
  registry.register(fileOutboundManifest);
  registry.register(discordWebhookManifest);
  registry.register(githubManifest);
  registry.register(googleSheetsManifest);
  registry.register(adManifest);
  registry.register(oktaManifest);
  registry.register(serviceNowManifest);
}
