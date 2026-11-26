import { Test, TestingModule } from '@nestjs/testing';
import { ServiceNowService } from './servicenow.service';
import { ServiceNowClient } from './servicenow.client';
import { ConnectorConfigService } from '../connector-config.service';
import { createMockUser } from '@testing';
import { ServiceNowConfig } from './servicenow.interface';

describe('ServiceNowService', () => {
  let service: ServiceNowService;
  let client: jest.Mocked<ServiceNowClient>;
  let connectorConfig: jest.Mocked<ConnectorConfigService>;

  const mockConfig: ServiceNowConfig = {
    instanceUrl: 'https://test.service-now.com',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    defaultAssignmentGroup: 'default-ag-sys-id',
    incidentCategory: 'Identity',
    incidentPriority: '3',
  };

  beforeEach(async () => {
    client = {
      createUser: jest.fn(),
      updateUser: jest.fn(),
      getUser: jest.fn(),
      createIncident: jest.fn(),
      findOpenIncident: jest.fn().mockResolvedValue(null),
      createChangeRequest: jest.fn(),
      listAssignmentGroups: jest.fn(),
      healthCheck: jest.fn(),
    } as unknown as jest.Mocked<ServiceNowClient>;

    connectorConfig = {
      getConfig: jest.fn(),
    } as unknown as jest.Mocked<ConnectorConfigService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServiceNowService,
        { provide: ServiceNowClient, useValue: client },
        { provide: ConnectorConfigService, useValue: connectorConfig },
      ],
    }).compile();

    service = module.get<ServiceNowService>(ServiceNowService);
  });

  // ── create (new user) ──────────────────────────────────────────────

  describe('create — new user', () => {
    it('should create a new ServiceNow user and tracking incident', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockConfig,
      } as any);

      // User does not exist
      client.getUser.mockResolvedValue(null);
      client.createUser.mockResolvedValue({
        sys_id: 'snow-new-001',
        user_name: 'john.doe@example.com',
        email: 'john.doe@example.com',
        first_name: 'John',
        last_name: 'Doe',
        active: 'true',
      });
      client.createIncident.mockResolvedValue({
        sys_id: 'inc-001',
        number: 'INC0010001',
        state: '1',
        short_description: '[EuroID] provision: John Doe (john.doe@example.com)',
        priority: '3',
      });

      const user = createMockUser();
      const result = await service.create(user);

      expect(client.getUser).toHaveBeenCalledWith(expect.any(Object), 'john.doe@example.com');
      expect(client.createUser).toHaveBeenCalled();
      expect(client.updateUser).not.toHaveBeenCalled();
      expect(client.createIncident).toHaveBeenCalled();
      expect(result.targetUserId).toBe('snow-snow-new-001');
    });
  });

  // ── create (existing user — update path) ──────────────────────────

  describe('create — existing user', () => {
    it('should update existing ServiceNow user and create tracking incident', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockConfig,
      } as any);

      // User already exists
      client.getUser.mockResolvedValue({
        sys_id: 'snow-existing-001',
        user_name: 'john.doe@example.com',
        email: 'john.doe@example.com',
        first_name: 'John',
        last_name: 'Doe',
        active: 'true',
      });
      client.updateUser.mockResolvedValue({
        sys_id: 'snow-existing-001',
        user_name: 'john.doe@example.com',
        email: 'john.doe@example.com',
        first_name: 'John',
        last_name: 'Doe',
        active: 'true',
      });
      client.createIncident.mockResolvedValue({
        sys_id: 'inc-002',
        number: 'INC0010002',
        state: '1',
        short_description: '[EuroID] provision: John Doe (john.doe@example.com)',
        priority: '3',
      });

      const user = createMockUser();
      const result = await service.create(user);

      expect(client.createUser).not.toHaveBeenCalled();
      expect(client.updateUser).toHaveBeenCalledWith(
        expect.any(Object),
        'snow-existing-001',
        expect.objectContaining({ email: 'john.doe@example.com' }),
      );
      expect(client.createIncident).toHaveBeenCalled();
      expect(result.targetUserId).toBe('snow-snow-existing-001');
    });
  });

  // Hunt 2026-11-25 (01 F12): deprovision sets active=false and locked_out=true, but provision set
  // only active=true, so a rehire stayed locked out; and each retry of provision (Temporal
  // retries the activity after a later failure) created another tracking incident.
  describe('create: a returning user and a retried provision', () => {
    const existing = {
      sys_id: 'snow-existing-001',
      user_name: 'john.doe@example.com',
      email: 'john.doe@example.com',
      first_name: 'John',
      last_name: 'Doe',
      active: 'false',
    };

    beforeEach(() => {
      connectorConfig.getConfig.mockResolvedValue({ config: mockConfig } as never);
      client.getUser.mockResolvedValue(existing);
      client.updateUser.mockResolvedValue({ ...existing, active: 'true' });
      client.createIncident.mockResolvedValue({
        sys_id: 'inc-1',
        number: 'INC0010001',
        state: '1',
        short_description: 'x',
        priority: '3',
      });
    });

    it('unlocks the record of an active user it reactivates', async () => {
      await service.create(createMockUser());

      expect(client.updateUser).toHaveBeenCalledWith(
        expect.any(Object),
        'snow-existing-001',
        expect.objectContaining({ active: 'true', locked_out: 'false' }),
      );
    });

    it('creates no second tracking incident when a retry finds the open one', async () => {
      await service.create(createMockUser());
      const correlationId = client.createIncident.mock.calls[0][1].correlation_id;
      client.findOpenIncident.mockResolvedValue({
        sys_id: 'inc-1',
        number: 'INC0010001',
        state: '1',
        short_description: 'x',
        priority: '3',
      });

      await service.create(createMockUser());

      expect(correlationId).toMatch(/^euroid-/);
      expect(client.findOpenIncident).toHaveBeenLastCalledWith(expect.any(Object), correlationId);
      expect(client.createIncident).toHaveBeenCalledTimes(1);
    });
  });

  // ── create — field mapping ─────────────────────────────────────────

  describe('create — field mapping', () => {
    it('should map StandardUserDto fields to ServiceNow user fields', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockConfig,
      } as any);

      client.getUser.mockResolvedValue(null);
      client.createUser.mockResolvedValue({
        sys_id: 'snow-mapped-001',
        user_name: 'john.doe@example.com',
        email: 'john.doe@example.com',
        first_name: 'John',
        last_name: 'Doe',
        active: 'true',
      });
      client.createIncident.mockResolvedValue({
        sys_id: 'inc-003',
        number: 'INC0010003',
        state: '1',
        short_description: 'test',
        priority: '3',
      });

      const user = createMockUser({
        jobTitle: 'CTO',
        departmentName: 'Executive',
        mobilePhone: '+358401111111',
        employeeId: 'EMP-999',
      });
      await service.create(user);

      const createUserCall = client.createUser.mock.calls[0];
      const fields = createUserCall[1]; // second arg = fields
      expect(fields.title).toBe('CTO');
      expect(fields.department).toBe('Executive');
      expect(fields.mobile_phone).toBe('+358401111111');
      expect(fields.employee_number).toBe('EMP-999');
      expect(fields.active).toBe('true');
    });

    it('should set active=false for inactive users', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockConfig,
      } as any);

      client.getUser.mockResolvedValue(null);
      client.createUser.mockResolvedValue({
        sys_id: 'snow-inactive-001',
        user_name: 'inactive@example.com',
        email: 'inactive@example.com',
        first_name: 'Jane',
        last_name: 'Doe',
        active: 'false',
      });
      client.createIncident.mockResolvedValue({
        sys_id: 'inc-004',
        number: 'INC0010004',
        state: '1',
        short_description: 'test',
        priority: '3',
      });

      const user = createMockUser({ status: 'INACTIVE' as any });
      await service.create(user);

      const createUserCall = client.createUser.mock.calls[0];
      expect(createUserCall[1].active).toBe('false');
    });
  });

  // ── create — incident fields ───────────────────────────────────────

  describe('create — incident fields', () => {
    it('should create incident with correct short_description format', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockConfig,
      } as any);

      client.getUser.mockResolvedValue(null);
      client.createUser.mockResolvedValue({
        sys_id: 'snow-inc-001',
        user_name: 'john.doe@example.com',
        email: 'john.doe@example.com',
        first_name: 'John',
        last_name: 'Doe',
        active: 'true',
      });
      client.createIncident.mockResolvedValue({
        sys_id: 'inc-005',
        number: 'INC0010005',
        state: '1',
        short_description: '[EuroID] provision: John Doe (john.doe@example.com)',
        priority: '3',
      });

      const user = createMockUser();
      await service.create(user);

      const incidentCall = client.createIncident.mock.calls[0];
      const incidentFields = incidentCall[1]; // second arg = fields
      expect(incidentFields.short_description).toContain('[EuroID]');
      expect(incidentFields.short_description).toContain('John Doe');
      expect(incidentFields.priority).toBe('3');
      expect(incidentFields.contact_type).toBe('Integration');
    });

    it('should use intent operation if provided', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockConfig,
      } as any);

      client.getUser.mockResolvedValue(null);
      client.createUser.mockResolvedValue({
        sys_id: 'snow-intent-001',
        user_name: 'john.doe@example.com',
        email: 'john.doe@example.com',
        first_name: 'John',
        last_name: 'Doe',
        active: 'true',
      });
      client.createIncident.mockResolvedValue({
        sys_id: 'inc-006',
        number: 'INC0010006',
        state: '1',
        short_description: '[EuroID] onboard: John Doe (john.doe@example.com)',
        priority: '3',
      });

      const user = createMockUser();
      await service.create(user, { operation: 'onboard', description: 'New hire onboarding' });

      const incidentCall = client.createIncident.mock.calls[0];
      const incidentFields = incidentCall[1];
      expect(incidentFields.short_description).toContain('onboard');
      expect(incidentFields.description).toBe('New hire onboarding');
    });
  });

  // ── healthCheck ────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('should return true when client health check passes', async () => {
      client.healthCheck.mockResolvedValue(true);
      const result = await service.healthCheck(mockConfig);
      expect(result).toBe(true);
    });

    it('should return false when client health check fails', async () => {
      client.healthCheck.mockResolvedValue(false);
      const result = await service.healthCheck(mockConfig);
      expect(result).toBe(false);
    });

    it('should return false when config resolution fails', async () => {
      connectorConfig.getConfig.mockResolvedValue(null);
      const result = await service.healthCheck();
      expect(result).toBe(false);
    });
  });

  // ── discover ───────────────────────────────────────────────────────

  describe('discover', () => {
    it('should return assignment groups as entitlements', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockConfig,
      } as any);

      client.listAssignmentGroups.mockResolvedValue([
        { sys_id: 'ag-001', name: 'IT Support', active: 'true' },
        { sys_id: 'ag-002', name: 'HR Team', active: 'true' },
        { sys_id: 'ag-003', name: 'Security', active: 'true', description: 'Security team' },
      ]);

      const result = await service.discover();

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        nativeId: 'ag-001',
        name: 'IT Support',
        type: 'assignment_group',
      });
      expect(result[1].nativeId).toBe('ag-002');
      expect(result[2].name).toBe('Security');
    });

    it('should return empty array when no assignment groups exist', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockConfig,
      } as any);

      client.listAssignmentGroups.mockResolvedValue([]);

      const result = await service.discover();
      expect(result).toHaveLength(0);
    });
  });

  // ── Config resolution ──────────────────────────────────────────────

  describe('config resolution', () => {
    it('should throw ConnectorException when no config is available', async () => {
      connectorConfig.getConfig.mockResolvedValue({ config: {} } as any);

      const user = createMockUser();
      await expect(service.create(user)).rejects.toThrow(/not configured/);
    });

    it('should throw when ConnectorConfigService returns null', async () => {
      connectorConfig.getConfig.mockResolvedValue(null);

      const user = createMockUser();
      await expect(service.create(user)).rejects.toThrow();
    });
  });
});
