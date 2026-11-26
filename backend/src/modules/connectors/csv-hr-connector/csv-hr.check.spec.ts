import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CsvHrService } from './csv-hr.service';

// A 2 KB limit (CSV_HR_MAX_FILE_SIZE_MB), so a file over it is small enough for a test
jest.mock('@infrastructure/config/defaults', () => ({
  ...jest.requireActual('@infrastructure/config/defaults'),
  CSV_HR_MAX_FILE_SIZE_MB: 2 / 1024,
}));

/**
 * POST /connectors/csv-hr/health-check (CsvHrService.checkSource). CSV HR reads one file,
 * `filePath` under CSV_HR_ALLOWED_DIR (there is no upload). The check reads what it can without
 * importing: the column map parses, the file is inside the allowed directory, exists, is a file
 * the server can read and is within CSV_HR_MAX_FILE_SIZE_MB, the limit ingest enforces. It
 * answered 400 "Health check not implemented" before.
 */
describe('CsvHrService.checkSource', () => {
  const service = new CsvHrService();
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-hr-check-'));
    fs.writeFileSync(path.join(dir, 'employees.csv'), 'Employee ID,Email\n1,a@example.com\n');
    previous = process.env.CSV_HR_ALLOWED_DIR;
    process.env.CSV_HR_ALLOWED_DIR = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CSV_HR_ALLOWED_DIR;
    else process.env.CSV_HR_ALLOWED_DIR = previous;
    fs.chmodSync(path.join(dir, 'employees.csv'), 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is healthy when the file can be read and the column map parses', async () => {
    await expect(
      service.checkSource({
        filePath: 'employees.csv',
        columnMap: '{"Employee ID": "sourceUserId", "Email": "email"}',
      }),
    ).resolves.toEqual({
      healthy: true,
      message: 'employees.csv can be read (34 bytes) and the column map is valid',
    });
  });

  it('refuses a column map ingest would refuse, naming the entry', async () => {
    await expect(
      service.checkSource({ filePath: 'employees.csv', columnMap: '{"Email": "mail"}' }),
    ).resolves.toMatchObject({
      healthy: false,
      error: expect.stringContaining('config.columnMap: "Email" maps to "mail"'),
    });
  });

  it('names a missing file, a directory and a file the server cannot read', async () => {
    fs.mkdirSync(path.join(dir, 'folder'));
    await expect(service.checkSource({ filePath: 'missing.csv' })).resolves.toEqual({
      healthy: false,
      error: 'File not found: missing.csv',
    });
    await expect(service.checkSource({ filePath: 'folder' })).resolves.toEqual({
      healthy: false,
      error: 'folder is not a file',
    });
    // Root reads any file: the permission check means nothing there
    if (process.getuid?.() !== 0) {
      fs.chmodSync(path.join(dir, 'employees.csv'), 0o000);
      await expect(service.checkSource({ filePath: 'employees.csv' })).resolves.toEqual({
        healthy: false,
        error: 'employees.csv cannot be read by the server',
      });
    }
  });

  const OUTSIDE =
    'CsvHrConnector: The file path is outside the allowed directory (CSV_HR_ALLOWED_DIR)';

  it('refuses a path outside CSV_HR_ALLOWED_DIR, as ingest does, without naming a server path', async () => {
    const result = await service.checkSource({ filePath: '../../etc/passwd' });

    expect(result).toEqual({ healthy: false, error: OUTSIDE });
    expect(JSON.stringify(result)).not.toContain(dir);
  });

  // A symlink inside the directory must not reach a file outside it, nor tell whether one exists
  it('refuses a symlink that leads outside CSV_HR_ALLOWED_DIR, whether its target exists or not', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-hr-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'secret.csv'), 'Email\nx@example.com\n');
      fs.symlinkSync(outside, path.join(dir, 'link'));
      fs.symlinkSync(path.join(outside, 'secret.csv'), path.join(dir, 'file-link.csv'));

      for (const filePath of ['link/secret.csv', 'link/missing.csv', 'file-link.csv']) {
        await expect(service.checkSource({ filePath })).resolves.toEqual({
          healthy: false,
          error: OUTSIDE,
        });
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads a file through a symlink that stays inside CSV_HR_ALLOWED_DIR', async () => {
    fs.symlinkSync(path.join(dir, 'employees.csv'), path.join(dir, 'current.csv'));

    await expect(service.checkSource({ filePath: 'current.csv' })).resolves.toEqual({
      healthy: true,
      message: 'current.csv can be read (34 bytes) and the column map is valid',
    });
  });

  it('refuses a file over CSV_HR_MAX_FILE_SIZE_MB, which ingest would not read', async () => {
    fs.writeFileSync(path.join(dir, 'big.csv'), 'x'.repeat(3000));

    await expect(service.checkSource({ filePath: 'big.csv' })).resolves.toEqual({
      healthy: false,
      error: 'big.csv is 3000 bytes, over the limit of 2048 (CSV_HR_MAX_FILE_SIZE_MB)',
    });
  });

  it('needs a file path', async () => {
    await expect(service.checkSource({})).resolves.toEqual({
      healthy: false,
      error: 'filePath is required',
    });
  });
});
