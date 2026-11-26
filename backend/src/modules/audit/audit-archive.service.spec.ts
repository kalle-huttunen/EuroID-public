import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { BadRequestException } from '@nestjs/common';
import { gunzipSync } from 'zlib';
import { AuditArchiveService } from './audit-archive.service';
import { AuditMerkleRoot } from './schemas/audit-merkle-root.schema';
import { AuditEvent } from './schemas/audit-event.schema';

describe('AuditArchiveService', () => {
  let service: AuditArchiveService;
  let mockMerkleRootModel: any;
  let mockAuditEventModel: any;
  let mockStorageAdapter: any;

  const checkpoint = {
    _id: 'merkle-1',
    checkpointId: 'cp-001',
    tenantId: 'test-tenant',
    rootHash: 'abc123',
    previousRootHash: 'prev123',
    eventCount: 2,
    treeDepth: 1,
    firstEventTimestamp: '2025-01-01T00:00:00Z',
    lastEventTimestamp: '2025-01-01T01:00:00Z',
    eventHashes: ['hash1', 'hash2'],
    archived: false,
  };

  const events = [
    {
      _id: 'e1',
      integrityHash: 'hash1',
      previousHash: 'prev',
      action: 'LOGIN',
      severity: 'info',
      timestamp: '2025-01-01T00:00:00Z',
      resourceType: 'auth',
      resourceId: '1',
      actor: 'user1',
      resourceName: 'Login',
      description: 'Logged in',
    },
    {
      _id: 'e2',
      integrityHash: 'hash2',
      previousHash: 'hash1',
      action: 'LOGOUT',
      severity: 'info',
      timestamp: '2025-01-01T01:00:00Z',
      resourceType: 'auth',
      resourceId: '2',
      actor: 'user1',
      resourceName: 'Logout',
      description: 'Logged out',
    },
  ];

  beforeEach(async () => {
    mockMerkleRootModel = {
      findById: jest.fn(),
      find: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    mockAuditEventModel = {
      find: jest.fn(),
    };

    mockStorageAdapter = {
      upload: jest.fn().mockResolvedValue('s3://bucket/path.json.gz'),
      uploadWithLock: jest.fn().mockResolvedValue('s3://bucket/path.json.gz'),
    };

    // Set env before module creation
    process.env.AUDIT_ARCHIVE_ENABLED = 'true';
    process.env.AUDIT_ARCHIVE_INCLUDE_PAYLOAD = 'false';

    const module = await Test.createTestingModule({
      providers: [
        AuditArchiveService,
        { provide: getModelToken(AuditMerkleRoot.name), useValue: mockMerkleRootModel },
        { provide: getModelToken(AuditEvent.name), useValue: mockAuditEventModel },
        { provide: 'AUDIT_ARCHIVE_STORAGE', useValue: mockStorageAdapter },
      ],
    }).compile();

    service = module.get(AuditArchiveService);
  });

  afterEach(() => {
    delete process.env.AUDIT_ARCHIVE_ENABLED;
    delete process.env.AUDIT_ARCHIVE_INCLUDE_PAYLOAD;
  });

  describe('isEnabled', () => {
    it('should return true when AUDIT_ARCHIVE_ENABLED is true', () => {
      expect(service.isEnabled()).toBe(true);
    });
  });

  describe('exportToS3', () => {
    beforeEach(() => {
      mockMerkleRootModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(checkpoint) }),
      });
      mockAuditEventModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(events) }),
        }),
      });
    });

    it('should export checkpoint to S3 with Object Lock', async () => {
      const result = await service.exportToS3('test-tenant', 'merkle-1');

      expect(mockStorageAdapter.uploadWithLock).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.stringContaining('test-tenant/audit-archive/'),
        expect.any(Number),
      );
      expect(mockMerkleRootModel.updateOne).toHaveBeenCalledWith(
        { _id: 'merkle-1' },
        { $set: { archived: true } },
      );
      expect(result).toEqual(
        expect.objectContaining({
          storagePath: expect.any(String),
          sizeBytes: expect.any(Number),
          checksum: expect.any(String),
          eventCount: 2,
        }),
      );
    });

    it('should fall back to upload without lock when uploadWithLock not available', async () => {
      mockStorageAdapter.uploadWithLock = undefined;

      const result = await service.exportToS3('test-tenant', 'merkle-1');

      expect(mockStorageAdapter.upload).toHaveBeenCalled();
      expect(result.eventCount).toBe(2);
    });

    it('should throw when checkpoint not found', async () => {
      mockMerkleRootModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      });

      await expect(service.exportToS3('test-tenant', 'merkle-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw when checkpoint belongs to different tenant', async () => {
      mockMerkleRootModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({ ...checkpoint, tenantId: 'other-tenant' }),
        }),
      });

      await expect(service.exportToS3('test-tenant', 'merkle-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw when checkpoint already archived', async () => {
      mockMerkleRootModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({ ...checkpoint, archived: true }),
        }),
      });

      await expect(service.exportToS3('test-tenant', 'merkle-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw when checkpoint has zero events', async () => {
      mockMerkleRootModel.findById.mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({ ...checkpoint, eventHashes: [] }),
        }),
      });

      await expect(service.exportToS3('test-tenant', 'merkle-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    /** The events of the archive the service uploaded, as stored. */
    const archivedEvents = (): Array<Record<string, unknown>> =>
      JSON.parse(gunzipSync(mockStorageAdapter.uploadWithLock.mock.calls[0][0]).toString('utf8'))
        .events;

    it('archives hashes and metadata only when AUDIT_ARCHIVE_INCLUDE_PAYLOAD is false', async () => {
      await service.exportToS3('test-tenant', 'merkle-1');

      expect(archivedEvents()).toEqual([
        {
          integrityHash: 'hash1',
          previousHash: 'prev',
          action: 'LOGIN',
          severity: 'info',
          timestamp: '2025-01-01T00:00:00Z',
          resourceType: 'auth',
          resourceId: '1',
        },
        {
          integrityHash: 'hash2',
          previousHash: 'hash1',
          action: 'LOGOUT',
          severity: 'info',
          timestamp: '2025-01-01T01:00:00Z',
          resourceType: 'auth',
          resourceId: '2',
        },
      ]);
    });

    it('archives the actor, names and description when AUDIT_ARCHIVE_INCLUDE_PAYLOAD is true', async () => {
      process.env.AUDIT_ARCHIVE_INCLUDE_PAYLOAD = 'true';
      const withPayload = new AuditArchiveService(
        mockMerkleRootModel,
        mockAuditEventModel,
        mockStorageAdapter,
      );

      await withPayload.exportToS3('test-tenant', 'merkle-1');

      expect(archivedEvents()[0]).toMatchObject({
        integrityHash: 'hash1',
        actor: 'user1',
        resourceName: 'Login',
        description: 'Logged in',
      });
    });
  });

  describe('getUnarchivedCheckpoints', () => {
    it('should return unarchived checkpoints older than 24 hours', async () => {
      const mockCheckpoints = [{ _id: 'cp1', checkpointId: 'cp-001', tenantId: 'test-tenant' }];
      mockMerkleRootModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockReturnValue({
              exec: jest.fn().mockResolvedValue(mockCheckpoints),
            }),
          }),
        }),
      });

      const result = await service.getUnarchivedCheckpoints('test-tenant');

      expect(mockMerkleRootModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'test-tenant',
          archived: false,
          createdAt: expect.objectContaining({ $lt: expect.any(Date) }),
        }),
      );
      expect(result).toEqual(mockCheckpoints);
    });
  });
});
