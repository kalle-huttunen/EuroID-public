import { Test, TestingModule } from '@nestjs/testing';
import { GitHubService } from './github.service';
import { GitHubClient } from './github.client';
import { ConnectorConfigService } from '../connector-config.service';
import { createMockUser } from '@testing/mock-factories';

describe('GitHubService', () => {
  let service: GitHubService;
  let client: jest.Mocked<GitHubClient>;

  beforeEach(async () => {
    const mockClient = {
      createInvitation: jest.fn(),
      healthCheck: jest.fn(),
    };

    const mockConnectorConfig = {
      getConfig: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitHubService,
        {
          provide: GitHubClient,
          useValue: mockClient,
        },
        {
          provide: ConnectorConfigService,
          useValue: mockConnectorConfig,
        },
      ],
    }).compile();

    service = module.get<GitHubService>(GitHubService);
    client = module.get(GitHubClient) as jest.Mocked<GitHubClient>;
  });

  it('provision() sends correct POST with email', async () => {
    const config = {
      personalAccessToken: 'ghp_test',
      orgName: 'my-company',
    };
    const user = createMockUser({
      email: 'alice@example.com',
      firstName: 'Alice',
    });

    client.createInvitation.mockResolvedValue({ targetUserId: 'github-alice@example.com' });

    const result = await service.provision(config, user);

    expect(result.targetUserId).toBe('github-alice@example.com');
    expect(client.createInvitation).toHaveBeenCalledWith(config, 'alice@example.com');
  });

  it('provision() throws when 404 org not found', async () => {
    const config = {
      personalAccessToken: 'ghp_test',
      orgName: 'nonexistent-org',
    };
    const user = createMockUser({ email: 'user@example.com' });

    client.createInvitation.mockRejectedValue(
      new Error('GitHub organization "nonexistent-org" not found. Check orgName.'),
    );

    await expect(service.provision(config, user)).rejects.toThrow(/not found/);
  });

  it('healthCheck() returns true when client succeeds', async () => {
    client.healthCheck.mockResolvedValue(true);
    const config = { personalAccessToken: 'ghp_test', orgName: 'my-company' };

    const result = await service.healthCheck(config);

    expect(result).toBe(true);
    expect(client.healthCheck).toHaveBeenCalledWith(config);
  });

  it('healthCheck() returns false when client fails', async () => {
    client.healthCheck.mockResolvedValue(false);
    const config = { personalAccessToken: 'ghp_invalid', orgName: 'my-company' };

    const result = await service.healthCheck(config);

    expect(result).toBe(false);
  });
});
