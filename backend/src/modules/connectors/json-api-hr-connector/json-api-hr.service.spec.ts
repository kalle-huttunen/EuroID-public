import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { JsonApiHrService } from './json-api-hr.service';
import { JsonApiHrClient } from './json-api-hr.client';
import { CONNECTOR_HEALTH_TIMEOUT_MS } from '@infrastructure/config/defaults';

describe('JsonApiHrService', () => {
  let service: JsonApiHrService;
  let client: jest.Mocked<JsonApiHrClient>;

  beforeEach(async () => {
    const mockClient = {
      fetch: jest.fn(),
      probe: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JsonApiHrService,
        {
          provide: JsonApiHrClient,
          useValue: mockClient,
        },
      ],
    }).compile();

    service = module.get<JsonApiHrService>(JsonApiHrService);
    client = module.get(JsonApiHrClient) as jest.Mocked<JsonApiHrClient>;
  });

  it('should fetch and map users from direct array response', async () => {
    client.fetch.mockResolvedValue([
      {
        emp_id: 'E001',
        first_name: 'Alice',
        last_name: 'Johnson',
        email: 'alice@example.com',
        job_title: 'Engineer',
      },
      { emp_id: 'E002', first_name: 'Bob', last_name: 'Smith', email: 'bob@example.com' },
    ]);

    const users = await service.fetchUsers({ url: 'https://api.example.com/users' });
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({
      sourceSystem: 'json-api-hr',
      sourceUserId: 'E001',
      tenantId: 'default',
      firstName: 'Alice',
      lastName: 'Johnson',
      email: 'alice@example.com',
      jobTitle: 'Engineer',
    });
    expect(users[1]).toMatchObject({
      sourceUserId: 'E002',
      email: 'bob@example.com',
    });
  });

  it('should handle { data: [...] } response shape', async () => {
    client.fetch.mockResolvedValue({
      data: [
        { employeeId: 'E003', firstName: 'Carol', lastName: 'White', email: 'carol@test.com' },
      ],
    });

    const users = await service.fetchUsers({
      url: 'https://api.example.com/users',
      responsePath: 'data',
    });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      sourceUserId: 'E003',
      firstName: 'Carol',
      lastName: 'White',
      email: 'carol@test.com',
    });
  });

  it('should handle { users: [...] } response shape', async () => {
    client.fetch.mockResolvedValue({
      users: [{ email: 'dave@x.com', firstName: 'Dave', lastName: 'Lee' }],
    });

    const users = await service.fetchUsers({
      url: 'https://api.example.com/users',
      responsePath: 'users',
      fieldMap: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
    });
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('dave@x.com');
    expect(users[0].sourceUserId).toBe('dave@x.com');
  });

  it('should throw when response is not an array and no responsePath', async () => {
    client.fetch.mockResolvedValue({ users: [] });

    await expect(service.fetchUsers({ url: 'https://api.example.com/users' })).rejects.toThrow(
      /not an array/,
    );
  });

  it('should throw when responsePath does not resolve to array', async () => {
    client.fetch.mockResolvedValue({ data: 'not-an-array' });

    await expect(
      service.fetchUsers({ url: 'https://api.example.com/users', responsePath: 'data' }),
    ).rejects.toThrow(/did not resolve to an array/);
  });

  it('should throw on HTTP error', async () => {
    client.fetch.mockRejectedValue(new Error('HTTP 500 - Server Error'));

    await expect(service.fetchUsers({ url: 'https://api.example.com/users' })).rejects.toThrow();
  });

  it('should throw when url is missing', async () => {
    await expect(service.fetchUsers({})).rejects.toThrow(/url is required/);
  });

  it('maps status and termination date through unchanged, and counts unmappable rows', async () => {
    client.fetch.mockResolvedValue([
      {
        emp_id: 'E001',
        first_name: 'Alice',
        last_name: 'Johnson',
        email: 'alice@example.com',
        status: 'inactive',
        terminationDate: '2026-11-20',
      },
      { emp_id: 'E002', first_name: 'Bob', last_name: 'Smith', email: 'bob@example.com' },
      'not-an-object',
      { emp_id: 'E003', first_name: 'No', last_name: 'Email' },
    ]);
    const stats = { skipped: 0 };

    const users = await service.fetchUsers({ url: 'https://api.example.com/users' }, 't1', stats);

    expect(users).toHaveLength(2);
    expect(users[0].customAttributes).toEqual({ hrStatus: 'inactive' });
    expect(users[0].endDate).toEqual(new Date('2026-11-20'));
    expect(users[0].status).toBe('ACTIVE');
    expect(users[1].customAttributes).toBeUndefined();
    expect(users[1].endDate).toBeUndefined();
    expect(stats.skipped).toBe(2);
  });

  it('maps the start date by default and from a custom fieldMap, as CSV HR parses it', async () => {
    client.fetch.mockResolvedValue([
      { emp_id: 'E1', email: 'ann@example.com', start_date: '2026-12-01' },
      { emp_id: 'E2', email: 'ben@example.com', startDate: '2027-01-15' },
      { emp_id: 'E3', email: 'cy@example.com', hireDate: '2026-11-02' },
      { emp_id: 'E4', email: 'dee@example.com', start_date: 'next Monday' },
    ]);
    const stats = { skipped: 0 };

    const users = await service.fetchUsers({ url: 'https://api.example.com/users' }, 't1', stats);

    expect(users.map((u) => u.startDate)).toEqual([
      new Date('2026-12-01'),
      new Date('2027-01-15'),
      new Date('2026-11-02'),
      undefined,
    ]);
    // An unreadable date keeps the row, without the date and with the value marked
    expect(users[3].customAttributes).toEqual({ startDateUnreadable: 'next Monday' });
    expect(stats.skipped).toBe(0);

    client.fetch.mockResolvedValue([{ id: 'E5', mail: 'eve@example.com', joined: '2026-12-24' }]);
    const [mapped] = await service.fetchUsers({
      url: 'https://api.example.com/users',
      fieldMap: { id: 'sourceUserId', mail: 'email', joined: 'startDate' },
    });
    expect(mapped.startDate).toEqual(new Date('2026-12-24'));
  });

  it('maps a GitHub login to the githubLogin custom attribute (default keys and a custom fieldMap)', async () => {
    client.fetch.mockResolvedValue([
      { emp_id: 'E1', email: 'ann@example.com', github_login: 'ann-gh', status: 'active' },
      { emp_id: 'E2', email: 'ben@example.com', githubLogin: 'ben-gh' },
    ]);

    const users = await service.fetchUsers({ url: 'https://api.example.com/users' });

    expect(users[0].customAttributes).toEqual({ hrStatus: 'active', githubLogin: 'ann-gh' });
    expect(users[1].customAttributes).toEqual({ githubLogin: 'ben-gh' });

    client.fetch.mockResolvedValue([{ id: 'E3', mail: 'cy@example.com', gh: 'cy-gh' }]);
    const [mapped] = await service.fetchUsers({
      url: 'https://api.example.com/users',
      fieldMap: { id: 'sourceUserId', mail: 'email', gh: 'customAttributes.githubLogin' },
    });
    expect(mapped.customAttributes).toEqual({ githubLogin: 'cy-gh' });
  });

  it('carries a key mapped to employeeNumber, which the employeeNumber rule correlates on', async () => {
    client.fetch.mockResolvedValue([
      { id: 'J7', mail: 'fay@example.com', staff_no: 'E-100' },
      { id: 'J8', mail: 'gus@example.com', staff_no: 4711 },
      { id: 'J9', mail: 'hal@example.com', staff_no: '' },
    ]);

    const users = await service.fetchUsers({
      url: 'https://api.example.com/users',
      fieldMap: { id: 'sourceUserId', mail: 'email', staff_no: 'employeeNumber' },
    });

    expect(users[0]).toMatchObject({ sourceUserId: 'J7', employeeNumber: 'E-100' });
    // A number in the feed is carried as text, as every mapped value is
    expect(users[1].employeeNumber).toBe('4711');
    expect(users[2]).not.toHaveProperty('employeeNumber');
  });

  it('reports the feed position of each returned user and logs a skipped row without its values', async () => {
    client.fetch.mockResolvedValue([
      { emp_id: 'E001', first_name: 'Alice', last_name: 'Johnson', email: 'alice@example.com' },
      { emp_id: 'E002', 'First Name': 'Hidden', last_name: 'Person' },
      { emp_id: 'E003', first_name: 'Bob', last_name: 'Smith', email: 'bob@example.com' },
    ]);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const stats = { skipped: 0, sourceRows: [] as number[] };

    const users = await service.fetchUsers({ url: 'https://api.example.com/users' }, 't1', stats);

    expect(users.map((u) => u.email)).toEqual(['alice@example.com', 'bob@example.com']);
    expect(stats.sourceRows).toEqual([1, 3]);
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('Skipping row 2');
    expect(logged).toContain('First Name');
    expect(logged).not.toContain('Hidden');
    expect(logged).not.toContain('E002');
    warn.mockRestore();
  });

  it('should skip rows missing sourceUserId or email', async () => {
    client.fetch.mockResolvedValue([
      { emp_id: 'E001', email: 'a@x.com' },
      { emp_id: 'E002' },
      { email: 'c@x.com' },
    ]);

    const users = await service.fetchUsers({ url: 'https://api.example.com/users' });
    expect(users).toHaveLength(2);
  });

  it('healthCheck probes the endpoint and never downloads the feed', async () => {
    expect(await service.healthCheck({ url: 'https://api.example.com/users' })).toBe(true);
    expect(client.probe).toHaveBeenCalledWith(
      { url: 'https://api.example.com/users', method: undefined, auth: undefined },
      CONNECTOR_HEALTH_TIMEOUT_MS,
    );
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it('healthCheck should return false when the probe fails or the endpoint refuses', async () => {
    client.probe.mockResolvedValueOnce(false);
    expect(await service.healthCheck({ url: 'https://api.example.com/users' })).toBe(false);
    client.probe.mockRejectedValueOnce(new Error('Network error'));
    expect(await service.healthCheck({ url: 'https://api.example.com/users' })).toBe(false);
  });

  describe('authentication config', () => {
    const url = 'https://api.example.com/users';

    beforeEach(() => client.fetch.mockResolvedValue([]));

    it('sends no credentials when authType is unset or "none"', async () => {
      await service.fetchUsers({ url });
      await service.fetchUsers({ url, authType: 'none', bearerToken: 'ignored' });

      expect(client.fetch).toHaveBeenNthCalledWith(1, { url, method: undefined, auth: undefined });
      expect(client.fetch).toHaveBeenNthCalledWith(2, { url, method: undefined, auth: undefined });
    });

    it('passes a bearer token for authType "bearer"', async () => {
      await service.fetchUsers({ url, authType: 'bearer', bearerToken: 'tok' });

      expect(client.fetch).toHaveBeenCalledWith({
        url,
        method: undefined,
        auth: { type: 'bearer', token: 'tok' },
      });
    });

    it('passes the custom header for authType "header"', async () => {
      await service.fetchUsers({
        url,
        authType: 'header',
        authHeaderName: 'X-API-Key',
        authHeaderSecret: 'k-1',
      });

      expect(client.fetch).toHaveBeenCalledWith({
        url,
        method: undefined,
        auth: { type: 'header', name: 'X-API-Key', value: 'k-1' },
      });
    });

    it('rejects incomplete or unknown auth config before calling the API', async () => {
      await expect(service.fetchUsers({ url, authType: 'bearer' })).rejects.toThrow(
        /bearerToken is required/,
      );
      await expect(
        service.fetchUsers({ url, authType: 'header', authHeaderName: 'X-API-Key' }),
      ).rejects.toThrow(/authHeaderName and authHeaderSecret are required/);
      await expect(service.fetchUsers({ url, authType: 'basic' })).rejects.toThrow(
        /authType must be/,
      );
      expect(client.fetch).not.toHaveBeenCalled();
    });

    it('healthCheck authenticates the same way as ingest', async () => {
      expect(await service.healthCheck({ url, authType: 'bearer', bearerToken: 'tok' })).toBe(true);
      expect(client.probe).toHaveBeenCalledWith(
        { url, method: undefined, auth: { type: 'bearer', token: 'tok' } },
        CONNECTOR_HEALTH_TIMEOUT_MS,
      );
    });
  });
});
