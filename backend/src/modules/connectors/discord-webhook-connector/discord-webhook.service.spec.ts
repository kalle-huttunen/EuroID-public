import { Test, TestingModule } from '@nestjs/testing';
import { DiscordWebhookService } from './discord-webhook.service';
import { DiscordWebhookClient } from './discord-webhook.client';
import { ConnectorConfigService } from '../connector-config.service';
import { createMockUser } from '@testing/mock-factories';

describe('DiscordWebhookService', () => {
  let service: DiscordWebhookService;
  let client: jest.Mocked<DiscordWebhookClient>;

  beforeEach(async () => {
    const mockClient = {
      postMessage: jest.fn().mockResolvedValue(true),
      healthCheck: jest.fn().mockResolvedValue(true),
    };

    const mockConnectorConfig = {
      getConfig: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscordWebhookService,
        {
          provide: DiscordWebhookClient,
          useValue: mockClient,
        },
        {
          provide: ConnectorConfigService,
          useValue: mockConnectorConfig,
        },
      ],
    }).compile();

    service = module.get<DiscordWebhookService>(DiscordWebhookService);
    client = module.get(DiscordWebhookClient) as jest.Mocked<DiscordWebhookClient>;
  });

  it('provision() POSTs correct payload', async () => {
    const config = { webhookUrl: 'https://discord.com/api/webhooks/123/abc' };
    const user = createMockUser({
      email: 'alice@example.com',
      firstName: 'Alice',
      jobTitle: 'Engineer',
    });

    const result = await service.provision(config, user);

    expect(result.targetUserId).toBe('discord-alice@example.com');
    expect(client.postMessage).toHaveBeenCalledWith(
      config,
      'User alice@example.com (Engineer) provisioned!',
    );
  });

  it('provision() uses N/A when jobTitle is missing', async () => {
    const config = { webhookUrl: 'https://discord.com/api/webhooks/123/abc' };
    const user = createMockUser({
      email: 'bob@example.com',
      jobTitle: undefined,
    });

    await service.provision(config, user);

    expect(client.postMessage).toHaveBeenCalledWith(
      config,
      'User bob@example.com (N/A) provisioned!',
    );
  });

  it('healthCheck() returns true when client succeeds', async () => {
    client.healthCheck.mockResolvedValue(true);
    const config = { webhookUrl: 'https://discord.com/api/webhooks/123/abc' };

    const result = await service.healthCheck(config);

    expect(result).toBe(true);
    expect(client.healthCheck).toHaveBeenCalledWith(config);
  });

  it('healthCheck() returns false when client fails', async () => {
    client.healthCheck.mockResolvedValue(false);
    const config = { webhookUrl: 'https://discord.com/api/webhooks/invalid' };

    const result = await service.healthCheck(config);

    expect(result).toBe(false);
  });
});
