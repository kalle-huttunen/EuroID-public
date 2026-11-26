/**
 * Compliance Reporting Service
 *
 * Generates SOX and ISO 27001 reports by aggregating data from audit, SoD,
 * access review, risk scoring, anomaly, and privileged access modules.
 */

import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';
// pdfkit 0.15 has no bundled types; @types/pdfkit targets older versions
type PDFDocInstance = {
  pipe: (dest: NodeJS.WritableStream) => PDFDocInstance;
  end: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => PDFDocInstance;
  fontSize: (size: number) => PDFDocInstance;
  text: (
    text: string,
    x?: number | { align?: string; underline?: boolean },
    y?: number,
    options?: { align?: string; underline?: boolean },
  ) => PDFDocInstance;
  moveDown: (n?: number) => PDFDocInstance;
};

const PDFDocument = require('pdfkit') as new (options?: { margin?: number }) => PDFDocInstance;
import { stringify } from 'csv-stringify/sync';
import { AuditService } from '../audit/audit.service';
import { RiskScoringService } from '../risk-scoring/risk-scoring.service';
import { AccessAnomalyService } from '../anomaly/anomaly.service';
import { PrivilegedAccessService } from '../privileged-access/privileged-access.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import {
  CampaignStatus,
  ReviewCampaign,
  type ReviewCampaignDocument,
} from '../access-review/schemas/review-campaign.schema';
import {
  ReportMetadata,
  ReportMetadataDocument,
  ReportType,
  ReportFormat,
} from './schemas/report-metadata.schema';
import { SodPolicy, SodPolicyDocument } from '../policy/schemas/sod-policy.schema';
import { IdentityRiskScore, RiskScoreDocument } from '../risk-scoring/schemas/risk-score.schema';
import { AuditEvent, AuditEventDocument } from '../audit/schemas/audit-event.schema';
import { Identity, IdentityDocument } from '../identity/schemas/identity.schema';
import {
  EntitlementCatalog,
  EntitlementCatalogDocument,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { buildSoxReport, type SoxReportPayload } from './templates/sox-report.template';
import {
  buildIso27001Report,
  type Iso27001ReportPayload,
} from './templates/iso27001-report.template';
import { type ComplianceConfig, complianceConfig } from '@infrastructure/config/compliance.config';

/**
 * The audit actions of a policy or SoD policy change: the domain event types the audit handler
 * records (action = event type). A role bundle change that touches its policies emits
 * policy.updated too.
 */
const POLICY_CHANGE_ACTIONS: string[] = [
  DomainEventType.POLICY_CREATED,
  DomainEventType.POLICY_UPDATED,
  DomainEventType.POLICY_DELETED,
  DomainEventType.SOD_POLICY_CREATED,
  DomainEventType.SOD_POLICY_UPDATED,
  DomainEventType.SOD_POLICY_DELETED,
];

/**
 * The CONFIG_CHANGED entries that change a connector's configuration: the connector store's
 * (ConnectorConfigService), a node's connector settings (PATCH /blueprints/:id with settings),
 * and a canvas save that changed a connector's settings (BlueprintsService.saveCanvas records
 * which in `connectorConfigChanges`). A canvas save that changed none (a moved node, an edge)
 * is not one; nor is one audited before that field was recorded.
 */
const CONNECTOR_CONFIG_CHANGES = [
  { resourceType: 'connector' },
  { resourceType: 'blueprint-node', 'payload.metadata.configKeys.0': { $exists: true } },
  { resourceType: 'blueprint', 'payload.metadata.connectorConfigChanges.0': { $exists: true } },
];

export interface ReportResult {
  reportId: string;
  downloadUrl: string;
  summary: { criticalFindings: number; complianceScore: number };
}

@Injectable()
export class ComplianceReportingService {
  private readonly logger = new Logger(ComplianceReportingService.name);

  constructor(
    @InjectModel(ReportMetadata.name)
    private readonly reportModel: Model<ReportMetadataDocument>,
    @InjectModel(SodPolicy.name)
    private readonly sodPolicyModel: Model<SodPolicyDocument>,
    @InjectModel(IdentityRiskScore.name)
    private readonly riskScoreModel: Model<RiskScoreDocument>,
    @InjectModel(AuditEvent.name)
    private readonly auditModel: Model<AuditEventDocument>,
    @InjectModel(Identity.name)
    private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(EntitlementCatalog.name)
    private readonly catalogModel: Model<EntitlementCatalogDocument>,
    @InjectModel(ReviewCampaign.name)
    private readonly campaignModel: Model<ReviewCampaignDocument>,
    private readonly auditService: AuditService,
    private readonly riskScoringService: RiskScoringService,
    private readonly anomalyService: AccessAnomalyService,
    private readonly privilegedAccessService: PrivilegedAccessService,
    private readonly eventEmitter: DomainEventEmitterService,
    @Inject(complianceConfig.KEY) private readonly complianceConf: ComplianceConfig,
  ) {}

  async generateReport(
    type: ReportType,
    dateRange: { from: Date; to: Date },
    format: ReportFormat,
    generatedBy: string,
  ): Promise<ReportResult> {
    const tenantId = getCurrentTenantId();
    const reportId = randomUUID();

    this.logger.log(
      `[Compliance] Generating ${type} report for ${tenantId}, range ${dateRange.from.toISOString()} - ${dateRange.to.toISOString()}`,
    );

    const payload =
      type === 'SOX'
        ? await this.gatherSoxData(tenantId, dateRange)
        : await this.gatherIso27001Data(tenantId, dateRange);

    const buffer =
      format === 'PDF'
        ? await this.renderPdf(type, payload, dateRange)
        : await this.renderCsv(type, payload, dateRange);

    const reportsDir = resolve(this.complianceConf.reportsPath, tenantId);
    if (!existsSync(reportsDir)) {
      await mkdir(reportsDir, { recursive: true });
    }

    const ext = format === 'PDF' ? 'pdf' : 'csv';
    const filename = `${reportId}.${ext}`;
    const filePath = resolve(reportsDir, filename);
    await writeFile(filePath, buffer);

    const summary = this.extractSummary(type, payload);
    const meta: Partial<ReportMetadata> = {
      tenantId,
      reportId,
      type,
      format,
      dateRange,
      generatedBy,
      generatedAt: new Date(),
      fileSize: buffer.length,
      filePath,
      summary,
    };

    await this.reportModel.create(meta);

    this.eventEmitter.emit(
      DomainEventType.COMPLIANCE_REPORT_GENERATED,
      reportId,
      { type, format, tenantId, generatedBy },
      { actor: generatedBy },
    );

    return {
      reportId,
      downloadUrl: `/api/v1/compliance-reports/${reportId}/download`,
      summary,
    };
  }

  async listReports(
    tenantId: string,
    filters?: { type?: ReportType },
  ): Promise<ReportMetadataDocument[]> {
    const q: Record<string, unknown> = { tenantId };
    if (filters?.type) q.type = filters.type;

    return this.reportModel.find(q).sort({ generatedAt: -1 }).limit(100).exec();
  }

  async getReport(reportId: string): Promise<{ buffer: Buffer; format: ReportFormat }> {
    const tenantId = getCurrentTenantId();
    const meta = await this.reportModel.findOne({ reportId, tenantId }).exec();
    if (!meta) {
      throw new NotFoundException(`Report ${reportId} not found`);
    }

    const buffer = await readFile(meta.filePath);
    return { buffer, format: meta.format };
  }

  private async gatherSoxData(
    tenantId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<SoxReportPayload> {
    const fromStr = dateRange.from.toISOString();
    const toStr = dateRange.to.toISOString();

    const [
      auditStats,
      integrityResult,
      riskDistribution,
      topRisky,
      sodPoliciesCount,
      identitiesWithSodViolations,
      campaigns,
      adminAccounts,
      adminActivationCount,
    ] = await Promise.all([
      this.auditModel
        .aggregate([
          { $match: { tenantId, timestamp: { $gte: dateRange.from, $lte: dateRange.to } } },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
              warnings: { $sum: { $cond: [{ $eq: ['$severity', 'warning'] }, 1, 0] } },
            },
          },
        ])
        .exec()
        .then((r) => r[0] ?? { total: 0, critical: 0, warnings: 0 }),
      this.auditService.verifyIntegrity(tenantId, fromStr, toStr),
      this.riskScoringService.getDistribution(tenantId),
      this.riskScoringService.getTopRisky(tenantId, 10),
      this.sodPolicyModel.countDocuments({ tenantId, isActive: true }).exec(),
      this.riskScoreModel
        .countDocuments({
          tenantId,
          'factors.factor': 'sod_violations',
          'factors.rawValue': { $gt: 0 },
        })
        .exec(),
      this.aggregateCampaignStats(tenantId, dateRange),
      this.privilegedAccessService.listAllAdminAccounts(tenantId),
      this.auditModel
        .countDocuments({
          tenantId,
          action: 'admin_account.activated',
          timestamp: { $gte: dateRange.from, $lte: dateRange.to },
        })
        .exec(),
    ]);

    const input = {
      dateRange,
      auditStats: {
        total: auditStats.total ?? 0,
        critical: auditStats.critical ?? 0,
        warnings: auditStats.warnings ?? 0,
      },
      riskDistribution: {
        average: riskDistribution.average ?? 0,
        median: riskDistribution.median ?? 0,
      },
      sodPoliciesCount,
      identitiesWithSodViolations,
      campaigns,
      adminAccounts: adminAccounts.map((a) => ({ adminTier: a.adminTier, status: a.status })),
      adminActivationEventsCount: adminActivationCount,
      topRisky: topRisky.map((r) => ({
        identityId: r.identityId,
        score: r.score,
        trend: r.trend ?? 'STABLE',
      })),
      integrityResult: {
        valid: integrityResult.valid,
        eventsChecked: integrityResult.eventsChecked,
        firstInvalid: integrityResult.firstInvalid,
      },
    };

    return buildSoxReport(input);
  }

  private async gatherIso27001Data(
    tenantId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<Iso27001ReportPayload> {
    const [
      totalIdentities,
      catalogBySystem,
      catalogByType,
      campaigns,
      anomalies,
      policyChangesCount,
      connectorConfigCount,
      identityLifecycleCount,
      piiRevealedCount,
      gdprErasureCount,
      dsarExportsCount,
    ] = await Promise.all([
      this.identityModel.countDocuments({ tenantId, deletedAt: { $exists: false } }).exec(),
      this.catalogModel
        .aggregate([{ $match: { tenantId } }, { $group: { _id: '$system', count: { $sum: 1 } } }])
        .exec()
        .then((r: Array<{ _id: string; count: number }>) =>
          Object.fromEntries(r.map((x) => [x._id, x.count])),
        ),
      this.catalogModel
        .aggregate([{ $match: { tenantId } }, { $group: { _id: '$type', count: { $sum: 1 } } }])
        .exec()
        .then((r: Array<{ _id: string; count: number }>) =>
          Object.fromEntries(r.map((x) => [x._id, x.count])),
        ),
      this.aggregateCampaignStats(tenantId, dateRange),
      this.anomalyService.listByDateRange(tenantId, dateRange.from, dateRange.to),
      this.auditModel
        .countDocuments({
          tenantId,
          action: { $in: POLICY_CHANGE_ACTIONS },
          timestamp: { $gte: dateRange.from, $lte: dateRange.to },
        })
        .exec(),
      this.auditModel
        .countDocuments({
          tenantId,
          action: 'CONFIG_CHANGED',
          timestamp: { $gte: dateRange.from, $lte: dateRange.to },
          $or: CONNECTOR_CONFIG_CHANGES,
        })
        .exec(),
      this.auditModel
        .countDocuments({
          tenantId,
          action: {
            $in: [
              'identity.created',
              'identity.updated',
              'identity.deleted',
              'identity.status_changed',
            ],
          },
          timestamp: { $gte: dateRange.from, $lte: dateRange.to },
        })
        .exec(),
      this.auditModel
        .countDocuments({
          tenantId,
          action: 'PII_REVEALED',
          timestamp: { $gte: dateRange.from, $lte: dateRange.to },
        })
        .exec(),
      this.auditModel
        .countDocuments({
          tenantId,
          action: 'GDPR_ERASURE_EXECUTED',
          // A dry run writes the same entry with dryRun: true; it erased nothing
          'payload.metadata.dryRun': { $ne: true },
          // One per request: a linked admin identity erased with the person has an entry of its
          // own naming the person (parentIdentityId)
          'payload.metadata.parentIdentityId': { $exists: false },
          timestamp: { $gte: dateRange.from, $lte: dateRange.to },
        })
        .exec(),
      this.auditModel
        .countDocuments({
          tenantId,
          action: 'DATA_EXPORTED',
          timestamp: { $gte: dateRange.from, $lte: dateRange.to },
        })
        .exec(),
    ]);

    const input = {
      dateRange,
      totalIdentities,
      entitlementsBySystem: catalogBySystem ?? {},
      accessTypes: catalogByType ?? {},
      campaigns: {
        completed: campaigns.completed,
        inProgress: campaigns.active,
        overdue: campaigns.overdue,
      },
      anomalies: anomalies.map((a) => ({
        type: a.type,
        severity: a.severity,
        status: a.status,
      })),
      policyChangesCount,
      connectorConfigChangesCount: connectorConfigCount,
      identityLifecycleEventsCount: identityLifecycleCount,
      piiRevealedCount,
      gdprErasureCount,
      dsarExportsCount,
    };

    return buildIso27001Report(input);
  }

  /**
   * The access review campaigns of the report's period, as they stood at its end (`asOf`: the
   * period's end, or now when that is later). Completed: campaigns completed within the period.
   * In progress: campaigns created by `asOf` and not completed by then (still ACTIVE, or
   * completed after it); overdue: those past their deadline at `asOf`. Pending reviews and
   * auto-revoked items are the in-progress campaigns' counters as stored now: their history is
   * not kept. Counted in MongoDB, so no campaign is left out.
   */
  private async aggregateCampaignStats(
    tenantId: string,
    dateRange: { from: Date; to: Date },
  ): Promise<{
    completed: number;
    active: number;
    overdue: number;
    totalPending: number;
    autoRevoked: number;
  }> {
    const asOf = new Date(Math.min(dateRange.to.getTime(), Date.now()));
    const [completed, inProgress] = await Promise.all([
      this.campaignModel
        .countDocuments({
          tenantId,
          status: CampaignStatus.COMPLETED,
          completedAt: { $gte: dateRange.from, $lte: dateRange.to },
        })
        .exec(),
      this.campaignModel
        .find({
          tenantId,
          createdAt: { $lte: asOf },
          $or: [
            { status: CampaignStatus.ACTIVE },
            { status: CampaignStatus.COMPLETED, completedAt: { $gt: asOf } },
          ],
        })
        .select('deadline stats')
        .lean()
        .exec(),
    ]);

    let overdue = 0;
    let totalPending = 0;
    let autoRevoked = 0;
    for (const c of inProgress) {
      if (c.deadline && new Date(c.deadline) < asOf) overdue++;
      totalPending += c.stats?.pending ?? 0;
      autoRevoked += c.stats?.expired ?? 0;
    }

    return { completed, active: inProgress.length, overdue, totalPending, autoRevoked };
  }

  private extractSummary(
    type: ReportType,
    payload: SoxReportPayload | Iso27001ReportPayload,
  ): { criticalFindings: number; complianceScore: number } {
    if (type === 'SOX') {
      const p = payload as SoxReportPayload;
      return {
        criticalFindings: p.executiveSummary.criticalFindingsCount,
        complianceScore: p.executiveSummary.overallComplianceScore,
      };
    }
    const p = payload as Iso27001ReportPayload;
    const critical =
      (p.incidentAnomalySummary.bySeverity?.['critical'] ?? 0) +
      (p.incidentAnomalySummary.bySeverity?.['high'] ?? 0);
    const score = Math.max(0, 100 - critical * 5);
    return {
      criticalFindings: critical,
      complianceScore: score,
    };
  }

  private async renderPdf(
    type: ReportType,
    payload: SoxReportPayload | Iso27001ReportPayload,
    dateRange: { from: Date; to: Date },
  ): Promise<Buffer> {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: unknown) => {
      chunks.push(chunk as Buffer);
    });

    doc.fontSize(18).text(`${type} Compliance Report`, { align: 'center' });
    doc.moveDown();
    doc
      .fontSize(10)
      .text(
        `Period: ${dateRange.from.toISOString().split('T')[0]} to ${dateRange.to.toISOString().split('T')[0]}`,
        { align: 'center' },
      );
    doc.moveDown(2);

    if (type === 'SOX') {
      const p = payload as SoxReportPayload;
      doc.fontSize(12).text('1. Executive Summary', { underline: true });
      doc.fontSize(10).text(`Compliance Score: ${p.executiveSummary.overallComplianceScore}`);
      doc.text(`Critical Findings: ${p.executiveSummary.criticalFindingsCount}`);
      doc.moveDown();
      doc.fontSize(12).text('2. Segregation of Duties', { underline: true });
      doc.text(`Active Policies: ${p.segregationOfDuties.activePoliciesCount}`);
      doc.text(`Identities with Violations: ${p.segregationOfDuties.identitiesWithViolations}`);
      doc.moveDown();
      doc.fontSize(12).text('3. Access Certification', { underline: true });
      doc.text(`Campaigns Completed: ${p.accessCertification.campaignsCompleted}`);
      doc.text(`Pending Reviews: ${p.accessCertification.totalPendingReviews}`);
      doc.moveDown();
      doc.fontSize(12).text('4. Privileged Access', { underline: true });
      doc.text(`Admin Accounts: ${p.privilegedAccess.adminAccountsTotal}`);
      doc.text(`Active Sessions: ${p.privilegedAccess.activeSessions}`);
      doc.moveDown();
      doc.fontSize(12).text('5. Risk Posture', { underline: true });
      doc.text(`Average Risk Score: ${p.riskPosture.averageRiskScore.toFixed(1)}`);
      doc.moveDown();
      doc.fontSize(12).text('6. Audit Trail Integrity', { underline: true });
      doc.text(`Valid: ${p.auditTrailIntegrity.valid ? 'Yes' : 'No'}`);
      doc.text(`Events Checked: ${p.auditTrailIntegrity.eventsChecked}`);
    } else {
      const p = payload as Iso27001ReportPayload;
      doc.fontSize(12).text('1. Access Control Inventory', { underline: true });
      doc.text(`Total Identities: ${p.accessControlInventory.totalIdentities}`);
      doc.moveDown();
      doc.fontSize(12).text('2. Periodic Review Status', { underline: true });
      doc.text(`Completed: ${p.periodicReviewStatus.campaignsCompleted}`);
      doc.text(`In Progress: ${p.periodicReviewStatus.campaignsInProgress}`);
      doc.text(`Overdue: ${p.periodicReviewStatus.campaignsOverdue}`);
      doc.moveDown();
      doc.fontSize(12).text('3. Incident & Anomaly Summary', { underline: true });
      doc.text(`Total Anomalies: ${p.incidentAnomalySummary.totalAnomalies}`);
      doc.moveDown();
      doc.fontSize(12).text('4. Change Management', { underline: true });
      doc.text(`Policy Changes: ${p.changeManagement.policyChanges}`);
      doc.text(`Connector Config Changes: ${p.changeManagement.connectorConfigChanges}`);
      doc.text(`Identity Lifecycle Events: ${p.changeManagement.identityLifecycleEvents}`);
      doc.moveDown();
      doc.fontSize(12).text('5. Data Protection', { underline: true });
      doc.text(`PII Revealed Events: ${p.dataProtection.piiRevealedEvents}`);
      doc.text(`GDPR Erasure Events: ${p.dataProtection.gdprErasureEvents}`);
      doc.text(`DSAR Exports: ${p.dataProtection.dsarExports}`);
    }

    doc.end();
    return new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
  }

  private async renderCsv(
    type: ReportType,
    payload: SoxReportPayload | Iso27001ReportPayload,
    dateRange: { from: Date; to: Date },
  ): Promise<Buffer> {
    const rows: Record<string, string>[] = [];

    if (type === 'SOX') {
      const p = payload as SoxReportPayload;
      rows.push({
        section: 'Executive Summary',
        key: 'Compliance Score',
        value: String(p.executiveSummary.overallComplianceScore),
      });
      rows.push({
        section: 'Executive Summary',
        key: 'Critical Findings',
        value: String(p.executiveSummary.criticalFindingsCount),
      });
      rows.push({
        section: 'SoD',
        key: 'Active Policies',
        value: String(p.segregationOfDuties.activePoliciesCount),
      });
      rows.push({
        section: 'SoD',
        key: 'Identities with Violations',
        value: String(p.segregationOfDuties.identitiesWithViolations),
      });
      rows.push({
        section: 'Access Certification',
        key: 'Campaigns Completed',
        value: String(p.accessCertification.campaignsCompleted),
      });
      rows.push({
        section: 'Access Certification',
        key: 'Pending Reviews',
        value: String(p.accessCertification.totalPendingReviews),
      });
      rows.push({
        section: 'Privileged Access',
        key: 'Admin Accounts',
        value: String(p.privilegedAccess.adminAccountsTotal),
      });
      rows.push({
        section: 'Privileged Access',
        key: 'Active Sessions',
        value: String(p.privilegedAccess.activeSessions),
      });
      rows.push({
        section: 'Risk Posture',
        key: 'Average Score',
        value: String(p.riskPosture.averageRiskScore.toFixed(1)),
      });
      rows.push({
        section: 'Audit Integrity',
        key: 'Valid',
        value: p.auditTrailIntegrity.valid ? 'Yes' : 'No',
      });
      rows.push({
        section: 'Audit Integrity',
        key: 'Events Checked',
        value: String(p.auditTrailIntegrity.eventsChecked),
      });
    } else {
      const p = payload as Iso27001ReportPayload;
      rows.push({
        section: 'Access Inventory',
        key: 'Total Identities',
        value: String(p.accessControlInventory.totalIdentities),
      });
      rows.push({
        section: 'Periodic Review',
        key: 'Completed',
        value: String(p.periodicReviewStatus.campaignsCompleted),
      });
      rows.push({
        section: 'Periodic Review',
        key: 'In Progress',
        value: String(p.periodicReviewStatus.campaignsInProgress),
      });
      rows.push({
        section: 'Periodic Review',
        key: 'Overdue',
        value: String(p.periodicReviewStatus.campaignsOverdue),
      });
      rows.push({
        section: 'Anomalies',
        key: 'Total',
        value: String(p.incidentAnomalySummary.totalAnomalies),
      });
      rows.push({
        section: 'Change Mgmt',
        key: 'Policy Changes',
        value: String(p.changeManagement.policyChanges),
      });
      rows.push({
        section: 'Change Mgmt',
        key: 'Connector Config',
        value: String(p.changeManagement.connectorConfigChanges),
      });
      rows.push({
        section: 'Data Protection',
        key: 'PII Revealed',
        value: String(p.dataProtection.piiRevealedEvents),
      });
      rows.push({
        section: 'Data Protection',
        key: 'GDPR Erasure',
        value: String(p.dataProtection.gdprErasureEvents),
      });
      rows.push({
        section: 'Data Protection',
        key: 'DSAR Exports',
        value: String(p.dataProtection.dsarExports),
      });
    }

    rows.unshift({ section: 'Report', key: 'Type', value: type });
    rows.unshift({
      section: 'Report',
      key: 'Period From',
      value: dateRange.from.toISOString().split('T')[0],
    });
    rows.unshift({
      section: 'Report',
      key: 'Period To',
      value: dateRange.to.toISOString().split('T')[0],
    });

    const csv = stringify(rows, { header: true, columns: ['section', 'key', 'value'] });
    return Buffer.from(csv, 'utf-8');
  }
}
