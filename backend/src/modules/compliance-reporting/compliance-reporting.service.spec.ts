/**
 * Compliance Reporting Service Unit Tests
 */

// Mock Temporal modules to prevent grpc-js native binary crash on Windows.
// The services the reporting service imports reach temporal-client.provider → @temporalio/client → @grpc/grpc-js
jest.mock('@temporalio/client', () => ({
  Connection: jest.fn(),
  Client: jest.fn(),
}));
jest.mock('../../infrastructure/temporal/temporal-client.provider', () => ({
  TemporalClientProvider: { provide: 'TEMPORAL_CLIENT', useValue: {} },
}));
// Mock pdfkit to avoid font file loading issues in test environment
jest.mock('pdfkit', () => {
  const { EventEmitter } = require('events');
  return jest.fn().mockImplementation(() => {
    const emitter = new EventEmitter();
    const doc: Record<string, unknown> = {};
    const chainFn = () => doc;
    doc.fontSize = jest.fn(chainFn);
    doc.font = jest.fn(chainFn);
    doc.text = jest.fn(chainFn);
    doc.moveDown = jest.fn(chainFn);
    doc.addPage = jest.fn(chainFn);
    doc.rect = jest.fn(chainFn);
    doc.fill = jest.fn(chainFn);
    doc.fillColor = jest.fn(chainFn);
    doc.strokeColor = jest.fn(chainFn);
    doc.lineWidth = jest.fn(chainFn);
    doc.stroke = jest.fn(chainFn);
    doc.pipe = jest.fn(chainFn);
    doc.on = (event: string, cb: (...a: unknown[]) => void) => {
      emitter.on(event, cb);
      return doc;
    };
    doc.end = () => {
      process.nextTick(() => {
        emitter.emit('data', Buffer.from('mock-pdf'));
        emitter.emit('end');
      });
    };
    return doc;
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { ComplianceReportingService } from './compliance-reporting.service';
import { ReportMetadata } from './schemas/report-metadata.schema';
import { SodPolicy } from '../policy/schemas/sod-policy.schema';
import { IdentityRiskScore } from '../risk-scoring/schemas/risk-score.schema';
import { AuditEvent } from '../audit/schemas/audit-event.schema';
import { Identity } from '../identity/schemas/identity.schema';
import { EntitlementCatalog } from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { AuditService } from '../audit/audit.service';
import { ReviewCampaign } from '../access-review/schemas/review-campaign.schema';
import { RiskScoringService } from '../risk-scoring/risk-scoring.service';
import { AccessAnomalyService } from '../anomaly/anomaly.service';
import { PrivilegedAccessService } from '../privileged-access/privileged-access.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { complianceConfig } from '@infrastructure/config/compliance.config';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { readFile, writeFile } from 'fs/promises';

jest.mock('fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from('mock-pdf-content')),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
}));

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'tenant-1' }),
}));

jest.mock('@infrastructure/multi-tenancy/tenant-context.helper', () => ({
  getCurrentTenantId: jest.fn().mockReturnValue('tenant-1'),
  withTenantContext: jest.fn((tenantId, fn) => fn()),
}));

describe('ComplianceReportingService', () => {
  let service: ComplianceReportingService;

  const mockReportModel = {
    create: jest.fn().mockResolvedValue({ reportId: 'r-1' }),
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    findOne: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    }),
  };

  const mockSodPolicyModel = {
    countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(2) }),
  };

  const mockRiskScoreModel = {
    countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(2) }),
  };

  const mockAuditModel = {
    aggregate: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue([{ total: 100, critical: 1, warnings: 5 }]),
    }),
    countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(3) }),
  };

  const mockIdentityModel = {
    countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(50) }),
  };

  const mockCatalogModel = {
    aggregate: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue([{ _id: 'entra', count: 20 }]),
    }),
  };

  const mockAuditService = {
    verifyIntegrity: jest.fn().mockResolvedValue({ valid: true, eventsChecked: 100 }),
  };

  // One campaign completed in the period, one in progress at its end
  const mockCampaignModel = {
    countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(1) }),
    find: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest
            .fn()
            .mockResolvedValue([{ deadline: new Date(), stats: { pending: 5, expired: 1 } }]),
        }),
      }),
    }),
  };

  const mockRiskScoringService = {
    getDistribution: jest.fn().mockResolvedValue({ average: 25, median: 20 }),
    getTopRisky: jest.fn().mockResolvedValue([{ identityId: 'id1', score: 80, trend: 'STABLE' }]),
  };

  const mockAnomalyService = {
    listByDateRange: jest
      .fn()
      .mockResolvedValue([{ type: 'TIME_BASED', severity: 'medium', status: 'open' }]),
  };

  const mockPrivilegedAccessService = {
    listAllAdminAccounts: jest.fn().mockResolvedValue([{ adminTier: 'TIER_1', status: 'ACTIVE' }]),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ComplianceReportingService,
        { provide: getModelToken(ReportMetadata.name), useValue: mockReportModel },
        { provide: getModelToken(SodPolicy.name), useValue: mockSodPolicyModel },
        { provide: getModelToken(IdentityRiskScore.name), useValue: mockRiskScoreModel },
        { provide: getModelToken(AuditEvent.name), useValue: mockAuditModel },
        { provide: getModelToken(Identity.name), useValue: mockIdentityModel },
        { provide: getModelToken(EntitlementCatalog.name), useValue: mockCatalogModel },
        { provide: AuditService, useValue: mockAuditService },
        { provide: getModelToken(ReviewCampaign.name), useValue: mockCampaignModel },
        { provide: RiskScoringService, useValue: mockRiskScoringService },
        { provide: AccessAnomalyService, useValue: mockAnomalyService },
        { provide: PrivilegedAccessService, useValue: mockPrivilegedAccessService },
        { provide: DomainEventEmitterService, useValue: mockEventEmitter },
        {
          provide: complianceConfig.KEY,
          useValue: { reportsPath: '/tmp/reports' },
        },
      ],
    }).compile();

    service = module.get(ComplianceReportingService);
  });

  describe('generateReport', () => {
    it('should return reportId and metadata for SOX PDF', async () => {
      const dateRange = { from: new Date('2025-01-01'), to: new Date('2025-01-31') };
      const result = await service.generateReport('SOX', dateRange, 'PDF', 'admin@test.com');

      // 1 critical audit event and 2 identities with SoD violations: 100 - 1 * 10 - 2 * 5
      const summary = { criticalFindings: 3, complianceScore: 80 };
      expect(result).toEqual({
        reportId: expect.any(String),
        downloadUrl: `/api/v1/compliance-reports/${result.reportId}/download`,
        summary,
      });
      expect(mockReportModel.create).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        reportId: result.reportId,
        type: 'SOX',
        format: 'PDF',
        dateRange,
        generatedBy: 'admin@test.com',
        generatedAt: expect.any(Date),
        fileSize: Buffer.from('mock-pdf').length,
        filePath: `/tmp/reports/tenant-1/${result.reportId}.pdf`,
        summary,
      });
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        DomainEventType.COMPLIANCE_REPORT_GENERATED,
        result.reportId,
        { type: 'SOX', format: 'PDF', tenantId: 'tenant-1', generatedBy: 'admin@test.com' },
        { actor: 'admin@test.com' },
      );
    });

    it('should return reportId and metadata for ISO27001 CSV', async () => {
      const dateRange = { from: new Date('2025-01-01'), to: new Date('2025-01-31') };
      const result = await service.generateReport('ISO27001', dateRange, 'CSV', 'admin@test.com');

      // One medium anomaly: no critical or high finding
      expect(result.summary).toEqual({ criticalFindings: 0, complianceScore: 100 });
      const [path, csv] = (writeFile as jest.Mock).mock.calls[0] as [string, Buffer];
      expect(path).toBe(`/tmp/reports/tenant-1/${result.reportId}.csv`);
      const lines = csv.toString('utf-8').trim().split('\n');
      expect(lines.slice(0, 4)).toEqual([
        'section,key,value',
        'Report,Period To,2025-01-31',
        'Report,Period From,2025-01-01',
        'Report,Type,ISO27001',
      ]);
      expect(lines).toContain('Access Inventory,Total Identities,50');
      expect(mockReportModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ format: 'CSV', fileSize: csv.length }),
      );
    });
  });

  describe('listReports', () => {
    it('should filter by type when provided', async () => {
      await service.listReports('tenant-1', { type: 'SOX' });
      expect(mockReportModel.find).toHaveBeenCalledWith(expect.objectContaining({ type: 'SOX' }));
    });
  });

  describe('getReport', () => {
    it('should throw NotFoundException when report not found', async () => {
      mockReportModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(service.getReport('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it("should return buffer and format when report exists, and only the caller tenant's", async () => {
      const stored = {
        reportId: 'r-1',
        tenantId: 'tenant-1',
        filePath: '/tmp/reports/tenant-1/r-1.pdf',
        format: 'PDF',
      };
      mockReportModel.findOne.mockImplementation((filter: Record<string, unknown>) => ({
        exec: jest
          .fn()
          .mockResolvedValue(
            filter.reportId === stored.reportId &&
              (filter.tenantId ?? stored.tenantId) === stored.tenantId
              ? stored
              : null,
          ),
      }));

      const { buffer, format } = await service.getReport('r-1');
      expect(buffer).toEqual(Buffer.from('mock-pdf-content'));
      expect(format).toBe('PDF');
      expect(readFile).toHaveBeenCalledWith('/tmp/reports/tenant-1/r-1.pdf');

      (getCurrentTenantId as jest.Mock).mockReturnValueOnce('tenant-2');
      await expect(service.getReport('r-1')).rejects.toThrow(NotFoundException);
    });
  });
});
