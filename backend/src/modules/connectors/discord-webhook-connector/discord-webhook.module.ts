import { Module, forwardRef } from '@nestjs/common';
import { DiscordWebhookService } from './discord-webhook.service';
import { DiscordWebhookClient } from './discord-webhook.client';
import { ConnectorConfigModule } from '../connector-config.module';

@Module({
  imports: [forwardRef(() => ConnectorConfigModule)],
  providers: [DiscordWebhookClient, DiscordWebhookService],
  exports: [DiscordWebhookService],
})
export class DiscordWebhookConnectorModule {}
