import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { FileOutboundService } from './file-outbound.service';
import { ConnectorConfigService } from '../connector-config.service';
import { createMockUser } from '@testing/mock-factories';

describe('FileOutboundService', () => {
  let service: FileOutboundService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(process.cwd(), 'test-file-outbound-temp');
    await fs.mkdir(tempDir, { recursive: true });

    const mockConnectorConfig = {
      getConfig: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileOutboundService,
        {
          provide: ConnectorConfigService,
          useValue: mockConnectorConfig,
        },
      ],
    }).compile();

    service = module.get<FileOutboundService>(FileOutboundService);
  });

  afterEach(async () => {
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('provision() appends correct JSON line to file', async () => {
    const outputPath = path.join(tempDir, 'provisioning-log.jsonl');
    const config = { outputFilePath: outputPath };
    const user = createMockUser({
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
      jobTitle: 'Engineer',
      departmentName: 'Engineering',
    });

    const before = Date.now();
    const result = await service.provision(config, user);
    const after = Date.now();

    expect(result.targetUserId).toMatch(/^file-\d+-alice@example\.com$/);
    const content = await fs.readFile(outputPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.user).toMatchObject({
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
      jobTitle: 'Engineer',
      departmentName: 'Engineering',
    });
    // The time of the append, as an ISO 8601 instant
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    expect(Date.parse(parsed.timestamp)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(parsed.timestamp)).toBeLessThanOrEqual(after);
  });

  it('provision() appends multiple lines on repeated calls', async () => {
    const outputPath = path.join(tempDir, 'multi.jsonl');
    const config = { outputFilePath: outputPath };
    const user = createMockUser({ email: 'bob@example.com' });

    await service.provision(config, user);
    await service.provision(config, user);

    const content = await fs.readFile(outputPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).user.email).toBe('bob@example.com');
    expect(JSON.parse(lines[1]).user.email).toBe('bob@example.com');
  });

  it('provision() includes intent when provided', async () => {
    const outputPath = path.join(tempDir, 'with-intent.jsonl');
    const config = { outputFilePath: outputPath };
    const user = createMockUser({ email: 'carol@example.com' });
    const intent = {
      operations: [{ type: 'group' as const, action: 'add' as const, targetId: 'g1' }],
    };

    await service.provision(config, user, intent);

    const content = await fs.readFile(outputPath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.intent).toEqual(intent);
  });

  it('healthCheck() returns true when directory is writable', async () => {
    const outputPath = path.join(tempDir, 'health-test.jsonl');
    const config = { outputFilePath: outputPath };

    const result = await service.healthCheck(config);

    expect(result).toBe(true);
    // File should exist (created by append)
    const stat = await fs.stat(outputPath);
    expect(stat.isFile()).toBe(true);
  });

  it('healthCheck() returns true when directory does not exist but can be created', async () => {
    const outputPath = path.join(tempDir, 'subdir', 'nested.jsonl');
    const config = { outputFilePath: outputPath };

    const result = await service.healthCheck(config);

    expect(result).toBe(true);
  });

  it('healthCheck() returns false when the directory cannot be created', async () => {
    // A regular file where a directory of the path should be: no user, root included, can
    // create the directory below it (ENOTDIR on every platform)
    const blocker = path.join(tempDir, 'not-a-directory');
    await fs.writeFile(blocker, '');
    const config = { outputFilePath: path.join(blocker, 'sub', 'file.jsonl') };

    const result = await service.healthCheck(config);

    expect(result).toBe(false);
  });

  /**
   * Hunt 2026-11-25 (01 F3): outputFilePath was any path, so a connector-admin could make the
   * worker append user data to any file it can write (application files, another tenant's
   * output) and the health check created directories anywhere. The path must now be inside
   * FILE_OUTBOUND_ALLOWED_DIR (the working directory outside production, required in
   * production), checked on the real path, symlinks resolved.
   */
  describe('the output path sandbox', () => {
    const user = createMockUser({ email: 'eve@example.com' });
    const savedEnv = { ...process.env };
    let outside: string;

    beforeEach(async () => {
      outside = await fs.mkdtemp(path.join(os.tmpdir(), 'euroid-outside-'));
    });

    afterEach(async () => {
      process.env = { ...savedEnv };
      await fs.rm(outside, { recursive: true, force: true });
    });

    it('refuses a path outside the allowed directory, and writes nothing', async () => {
      process.env.FILE_OUTBOUND_ALLOWED_DIR = tempDir;
      const target = path.join(outside, 'stolen.jsonl');

      await expect(service.provision({ outputFilePath: target }, user)).rejects.toThrow(
        /outside the allowed directory \(FILE_OUTBOUND_ALLOWED_DIR\)/,
      );
      await expect(fs.stat(target)).rejects.toThrow();
    });

    it('refuses ../ out of the allowed directory', async () => {
      process.env.FILE_OUTBOUND_ALLOWED_DIR = tempDir;

      await expect(service.provision({ outputFilePath: '../escaped.jsonl' }, user)).rejects.toThrow(
        /outside the allowed directory/,
      );
    });

    it('refuses a symlink inside the directory that leads outside', async () => {
      process.env.FILE_OUTBOUND_ALLOWED_DIR = tempDir;
      await fs.symlink(outside, path.join(tempDir, 'link'));

      await expect(
        service.provision({ outputFilePath: 'link/stolen.jsonl' }, user),
      ).rejects.toThrow(/outside the allowed directory/);
      await expect(fs.stat(path.join(outside, 'stolen.jsonl'))).rejects.toThrow();
    });

    it('resolves a relative path inside the allowed directory', async () => {
      process.env.FILE_OUTBOUND_ALLOWED_DIR = tempDir;

      await service.provision({ outputFilePath: 'out.jsonl' }, user);

      await expect(fs.readFile(path.join(tempDir, 'out.jsonl'), 'utf-8')).resolves.toContain(
        'eve@example.com',
      );
    });

    it('requires FILE_OUTBOUND_ALLOWED_DIR in production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.FILE_OUTBOUND_ALLOWED_DIR;

      await expect(
        service.provision({ outputFilePath: path.join(tempDir, 'x.jsonl') }, user),
      ).rejects.toThrow(/FILE_OUTBOUND_ALLOWED_DIR is required in production/);
    });

    it('answers the health check false for a path outside, creating no directory', async () => {
      process.env.FILE_OUTBOUND_ALLOWED_DIR = tempDir;
      const target = path.join(outside, 'new-dir', 'x.jsonl');

      await expect(service.healthCheck({ outputFilePath: target })).resolves.toBe(false);
      await expect(fs.stat(path.join(outside, 'new-dir'))).rejects.toThrow();
    });
  });
});
