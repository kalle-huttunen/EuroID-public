import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CsvHrService } from './csv-hr.service';

describe('CsvHrService', () => {
  let service: CsvHrService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), 'test-csv-temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [CsvHrService],
    }).compile();

    service = module.get<CsvHrService>(CsvHrService);
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('maps the HR status word and end date through unchanged, and counts unmappable rows', async () => {
    const csvPath = path.join(tempDir, 'lifecycle.csv');
    fs.writeFileSync(
      csvPath,
      'EmpID,First Name,Last Name,Email,Status,End Date\n' +
        'E001,Alice,Johnson,alice@example.com,Terminated,2026-11-20\n' +
        'E002,Bob,Smith,bob@example.com,Active,not-a-date\n' +
        'E003,No,Email,,Active,\n',
    );
    const stats = { skipped: 0 };

    const users = await service.fetchUsers({ filePath: csvPath }, 'tenant-a', stats);

    expect(users).toHaveLength(2);
    expect(users[0].customAttributes).toEqual({ hrStatus: 'Terminated' });
    expect(users[0].endDate).toEqual(new Date('2026-11-20'));
    // The connector does not interpret the status: the Golden Record status is untouched.
    expect(users[0].status).toBe('ACTIVE');
    // A bad date is left out rather than dropping the row.
    expect(users[1].endDate).toBeUndefined();
    expect(stats.skipped).toBe(1);
  });

  it('reports the CSV line of each returned user and logs a skipped row without its values', async () => {
    const csvPath = path.join(tempDir, 'rows.csv');
    fs.writeFileSync(
      csvPath,
      'EmpID,First Name,Last Name,Email\n' +
        'E001,Alice,Johnson,alice@example.com\n' +
        'E002,Hidden,Person,\n' +
        'E003,Bob,Smith,bob@example.com\n',
    );
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const stats = { skipped: 0, sourceRows: [] as number[] };

    const users = await service.fetchUsers({ filePath: csvPath }, 'tenant-a', stats);

    expect(users.map((u) => u.email)).toEqual(['alice@example.com', 'bob@example.com']);
    // The header is line 1, so the users came from lines 2 and 4
    expect(stats.sourceRows).toEqual([2, 4]);
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('Skipping row 3');
    expect(logged).toContain('First Name');
    // safeLog would have let "First Name" and "EmpID" through: no value of the row is logged
    expect(logged).not.toContain('Hidden');
    expect(logged).not.toContain('E002');
    warn.mockRestore();
  });

  it('keeps a row whose Start Date is not a date, without the date and with the cell marked', async () => {
    const csvPath = path.join(tempDir, 'start.csv');
    fs.writeFileSync(
      csvPath,
      'EmpID,First Name,Last Name,Email,Start Date\n' +
        'E001,Alice,Johnson,alice@example.com,2026-12-01\n' +
        'E002,Bob,Smith,bob@example.com,31.13.2026\n',
    );
    const stats = { skipped: 0 };

    const users = await service.fetchUsers({ filePath: csvPath }, 'tenant-a', stats);

    expect(users).toHaveLength(2);
    expect(users[0].startDate).toEqual(new Date('2026-12-01'));
    expect(users[0].customAttributes).toBeUndefined();
    // Not an Invalid Date that fails the row's validation: the row is kept, the cell is kept as
    // text, and joiner detection holds the person until a sync reads a date
    expect(users[1].startDate).toBeUndefined();
    expect(users[1].customAttributes).toEqual({ startDateUnreadable: '31.13.2026' });
    expect(stats.skipped).toBe(0);
  });

  it('reads a Termination Date column as the end date', async () => {
    const csvPath = path.join(tempDir, 'termination.csv');
    fs.writeFileSync(
      csvPath,
      'EmpID,First Name,Last Name,Email,Employment Status,Termination Date\n' +
        'E009,Cara,Lee,cara@example.com,left,2026-10-31\n',
    );

    const [user] = await service.fetchUsers({ filePath: csvPath });

    expect(user.customAttributes).toEqual({ hrStatus: 'left' });
    expect(user.endDate).toEqual(new Date('2026-10-31'));
  });

  it('should parse CSV with default column map', async () => {
    const csvPath = path.join(tempDir, 'users.csv');
    fs.writeFileSync(
      csvPath,
      'EmpID,First Name,Last Name,Email,Job Title,Department\n' +
        'E001,Alice,Johnson,alice@example.com,Engineer,Engineering\n' +
        'E002,Bob,Smith,bob@example.com,Analyst,Finance\n',
    );

    const users = await service.fetchUsers({ filePath: csvPath });
    expect(users).toHaveLength(2);
    expect(users[0]).toMatchObject({
      sourceSystem: 'csv-hr',
      sourceUserId: 'E001',
      tenantId: 'default',
      firstName: 'Alice',
      lastName: 'Johnson',
      email: 'alice@example.com',
      jobTitle: 'Engineer',
      departmentName: 'Engineering',
    });
    expect(users[1]).toMatchObject({
      sourceUserId: 'E002',
      email: 'bob@example.com',
      firstName: 'Bob',
      lastName: 'Smith',
    });
  });

  it('maps a GitHub Login column to the githubLogin custom attribute, next to the HR status', async () => {
    const csvPath = path.join(tempDir, 'github.csv');
    fs.writeFileSync(
      csvPath,
      'EmpID,First Name,Last Name,Email,Status,GitHub Login\n' +
        'E010,Dana,Ek,dana@example.com,Active,dana-ek\n' +
        'E011,Eli,Oy,eli@example.com,Active,\n',
    );

    const users = await service.fetchUsers({ filePath: csvPath });

    expect(users[0].customAttributes).toEqual({ hrStatus: 'Active', githubLogin: 'dana-ek' });
    // An empty cell maps nothing
    expect(users[1].customAttributes).toEqual({ hrStatus: 'Active' });
  });

  it('maps any column mapped to customAttributes.<key> to that custom attribute', async () => {
    const csvPath = path.join(tempDir, 'custom-attributes.csv');
    fs.writeFileSync(csvPath, 'id,mail,gh,badge\n' + '7,fay@example.com,fay-gh,B-12\n');

    const [user] = await service.fetchUsers({
      filePath: csvPath,
      columnMap: {
        id: 'sourceUserId',
        mail: 'email',
        gh: 'customAttributes.githubLogin',
        badge: 'customAttributes.badgeId',
      },
    });

    expect(user.customAttributes).toEqual({ githubLogin: 'fay-gh', badgeId: 'B-12' });
  });

  it('carries a column mapped to employeeNumber, which the employeeNumber rule correlates on', async () => {
    const csvPath = path.join(tempDir, 'employee-number.csv');
    fs.writeFileSync(
      csvPath,
      'id,mail,empno\n' + '7,fay@example.com,E-100\n' + '8,gus@example.com,\n',
    );

    const users = await service.fetchUsers({
      filePath: csvPath,
      columnMap: { id: 'sourceUserId', mail: 'email', empno: 'employeeNumber' },
    });

    expect(users[0]).toMatchObject({ sourceUserId: '7', employeeNumber: 'E-100' });
    // An empty cell maps nothing
    expect(users[1]).not.toHaveProperty('employeeNumber');
  });

  it('should parse CSV with custom column map', async () => {
    const csvPath = path.join(tempDir, 'custom.csv');
    fs.writeFileSync(
      csvPath,
      'employee_id,first,last,email_addr\n' + '123,Carol,White,carol@test.com\n',
    );

    const users = await service.fetchUsers({
      filePath: csvPath,
      columnMap: {
        employee_id: 'sourceUserId',
        first: 'firstName',
        last: 'lastName',
        email_addr: 'email',
      },
    });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      sourceUserId: '123',
      firstName: 'Carol',
      lastName: 'White',
      email: 'carol@test.com',
    });
  });

  it('should return empty array for empty file', async () => {
    const csvPath = path.join(tempDir, 'empty.csv');
    fs.writeFileSync(csvPath, 'EmpID,Email\n');

    const users = await service.fetchUsers({ filePath: csvPath });
    expect(users).toEqual([]);
  });

  it('should skip rows missing sourceUserId or email', async () => {
    const csvPath = path.join(tempDir, 'partial.csv');
    fs.writeFileSync(
      csvPath,
      'EmpID,First Name,Last Name,Email\n' +
        'E001,Alice,Johnson,alice@example.com\n' +
        ',Bob,Smith,\n' +
        'E003,,,charlie@example.com\n',
    );

    const users = await service.fetchUsers({ filePath: csvPath });
    expect(users).toHaveLength(2); // E001 and E003 (E003 has email as sourceUserId fallback)
    const emails = users.map((u) => u.email);
    expect(emails).toContain('alice@example.com');
    expect(emails).toContain('charlie@example.com');
  });

  it('should use config tenantId', async () => {
    const csvPath = path.join(tempDir, 'tenant.csv');
    fs.writeFileSync(csvPath, 'EmpID,Email\nE001,a@x.com\n');

    const users = await service.fetchUsers({ filePath: csvPath, tenantId: 'acme' });
    expect(users[0].tenantId).toBe('acme');
  });

  it('should throw when file not found', async () => {
    await expect(service.fetchUsers({ filePath: './nonexistent-file.csv' })).rejects.toThrow(
      /File not found/,
    );
  });

  it('names no server path when the file is missing or outside the allowed directory', async () => {
    const missing = await service.fetchUsers({ filePath: 'nonexistent-file.csv' }).catch((e) => e);
    const outside = await service.fetchUsers({ filePath: '../../etc/passwd' }).catch((e) => e);

    expect((missing as Error).message).toBe('CsvHrConnector: File not found: nonexistent-file.csv');
    expect((outside as Error).message).toBe(
      'CsvHrConnector: The file path is outside the allowed directory (CSV_HR_ALLOWED_DIR)',
    );
    expect(JSON.stringify([(missing as Error).message, (outside as Error).message])).not.toContain(
      process.cwd(),
    );
  });

  it('does not ingest a file a symlink inside the allowed directory points outside of', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-hr-ingest-outside-'));
    try {
      fs.writeFileSync(path.join(outsideDir, 'other.csv'), 'EmpID,Email\nX1,x@example.com\n');
      fs.symlinkSync(path.join(outsideDir, 'other.csv'), path.join(tempDir, 'link.csv'));

      await expect(
        service.fetchUsers({ filePath: path.join(tempDir, 'link.csv') }),
      ).rejects.toThrow(
        'CsvHrConnector: The file path is outside the allowed directory (CSV_HR_ALLOWED_DIR)',
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('should throw when filePath is missing', async () => {
    await expect(service.fetchUsers({})).rejects.toThrow(/filePath is required/);
  });

  it('healthCheck should return true when file exists', async () => {
    const csvPath = path.join(tempDir, 'exists.csv');
    fs.writeFileSync(csvPath, 'EmpID,Email\n');
    expect(await service.healthCheck({ filePath: csvPath })).toBe(true);
  });

  it('healthCheck should return false when file does not exist', async () => {
    expect(await service.healthCheck({ filePath: '/nonexistent/file.csv' })).toBe(false);
  });
});
