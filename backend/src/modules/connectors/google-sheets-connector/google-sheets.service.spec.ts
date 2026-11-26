import { Test, TestingModule } from '@nestjs/testing';
jest.mock('./google-sheets.client', () => ({
  GoogleSheetsClient: jest.fn().mockImplementation(() => ({
    appendRow: jest.fn(),
    healthCheck: jest.fn(),
  })),
}));
import { GoogleSheetsService } from './google-sheets.service';
import { GoogleSheetsClient } from './google-sheets.client';
import { ConnectorConfigService } from '../connector-config.service';
import { createMockUser } from '@testing/mock-factories';

describe('GoogleSheetsService', () => {
  let service: GoogleSheetsService;
  let client: jest.Mocked<GoogleSheetsClient>;

  beforeEach(async () => {
    const mockClient = {
      appendRow: jest.fn(),
      healthCheck: jest.fn(),
    };

    const mockConnectorConfig = {
      getConfig: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleSheetsService,
        {
          provide: GoogleSheetsClient,
          useValue: mockClient,
        },
        {
          provide: ConnectorConfigService,
          useValue: mockConnectorConfig,
        },
      ],
    }).compile();

    service = module.get<GoogleSheetsService>(GoogleSheetsService);
    client = module.get(GoogleSheetsClient) as jest.Mocked<GoogleSheetsClient>;
  });

  it('provision() appends row with correct columns', async () => {
    const config = {
      sheetId: 'test-sheet-id',
      serviceAccountJson: '{"client_email":"a@b.iam.gserviceaccount.com","private_key":"x"}',
    };
    const user = createMockUser({
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
      jobTitle: 'Engineer',
      departmentName: 'Engineering',
    });

    client.appendRow.mockResolvedValue({
      targetUserId: 'sheets-alice@example.com-1234567890',
    });

    const result = await service.provision(config, user);

    expect(result.targetUserId).toMatch(/^sheets-alice@example\.com-\d+$/);
    expect(client.appendRow).toHaveBeenCalledWith(config, user);
  });

  it('healthCheck() returns true when sheet accessible', async () => {
    client.healthCheck.mockResolvedValue(true);
    const config = {
      sheetId: 'test-sheet-id',
      serviceAccountJson: '{"client_email":"a@b.iam.gserviceaccount.com","private_key":"x"}',
    };

    const result = await service.healthCheck(config);

    expect(result).toBe(true);
    expect(client.healthCheck).toHaveBeenCalledWith(config);
  });

  it('healthCheck() returns false when sheet not accessible', async () => {
    client.healthCheck.mockResolvedValue(false);
    const config = {
      sheetId: 'invalid-sheet-id',
      serviceAccountJson: '{"client_email":"a@b.iam.gserviceaccount.com","private_key":"x"}',
    };

    const result = await service.healthCheck(config);

    expect(result).toBe(false);
  });
});
