/**
 * DSAR Export Service (GDPR Articles 15 & 20 — Right of Access / Portability)
 *
 * Collects all data related to a single identity across every collection
 * and returns a structured, machine-readable JSON package. Besides the collections read here by
 * name, it covers every collection a GDPR erasure reaches (gdpr-erasure-scope.ts), each through
 * its target's `dsar` view, so the export and the erasure cannot drift apart.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { ERASURE_TARGETS, scopeModel } from './gdpr-erasure-scope';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import type { UserEventDocument } from '../identity/schemas/user-event.schema';
import type { AuditEventDocument } from '../audit/schemas/audit-event.schema';
import type { ReviewItemDocument } from '../access-review/schemas/review-item.schema';
import type { ReviewExclusionDocument } from '../policy/schemas/review-exclusion.schema';
import { AuditService } from '../audit/audit.service';
import { IdentityEntitlementsService } from '../identity/identity-entitlements.service';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { ConsentService } from './consent.service';

/** A consent record as the export gives it: the subject's choice, not the record's bookkeeping. */
export interface DsarConsent {
  purpose: string;
  status: string;
  grantedAt?: Date;
  /** When the subject withdrew it. */
  revokedAt?: Date;
  expiresAt?: Date;
  /** How it was given: web-form, api, email, contract. */
  method?: string;
}

/** What the export gives of one identity: the person, or each of their linked admin identities. */
export interface DsarSections {
  timeline: Record<string, unknown>[];
  auditTrail: Record<string, unknown>[];
  accessReviews: Record<string, unknown>[];
  /** Access the subject lost in access reviews, kept as exclusions (active and lifted). */
  accessReviewExclusions: Record<string, unknown>[];
  /**
   * The subject's access, as the identity page lists it (GET /identity/:id/entitlements): each
   * policy or request grant with its system, source and status.
   */
  entitlements: Record<string, unknown>[];
  /** The subject's consent per purpose (GDPR Art. 6, 7), with its status as of the export. */
  consents: DsarConsent[];
  /**
   * The subject's records in every other collection a GDPR erasure reaches, keyed by collection
   * (gdpr-erasure-scope.ts): credential metadata (never credential material), risk scores,
   * anomalies, joiner, leaver, mover and offboarding records, drift findings, access requests for
   * them, and the subject's part in the agents they own, their peer groups and policy suggestions.
   * Other people's personal data and bookkeeping are left out (dsar-scope-views.ts).
   */
  records: Record<string, Record<string, unknown>[]>;
}

export interface DsarExportPackage extends DsarSections {
  exportedAt: string;
  exportedBy: string;
  dataSubjectId: string;
  identity: Record<string, unknown>;
  /**
   * The person's linked admin identities (one per admin tier, with the person's name and the
   * admin UPN), each with its document and the same sections: a GDPR erasure erases them with
   * the person.
   */
  linkedAdminIdentities: Array<{ identity: Record<string, unknown> } & DsarSections>;
  attestation: string;
}

@Injectable()
export class DsarExportService {
  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel('UserEvent') private readonly userEventModel: Model<UserEventDocument>,
    @InjectModel('AuditEvent') private readonly auditEventModel: Model<AuditEventDocument>,
    @InjectModel('ReviewItem') private readonly reviewItemModel: Model<ReviewItemDocument>,
    @InjectModel('ReviewExclusion')
    private readonly reviewExclusionModel: Model<ReviewExclusionDocument>,
    private readonly identityEntitlements: IdentityEntitlementsService,
    private readonly consentService: ConsentService,
    private readonly auditService: AuditService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** The subject's records in each collection of the erasure scope, through its `dsar` view. */
  private async scopeRecords(
    tenantId: string,
    identityId: string,
  ): Promise<Record<string, Record<string, unknown>[]>> {
    const targets = ERASURE_TARGETS.flatMap((t) => (t.dsar === 'consents' ? [] : [t]));
    const found = await Promise.all(
      targets.map(async (t) => {
        const view = t.dsar as Exclude<typeof t.dsar, 'consents'>;
        const docs = (await scopeModel(this.connection, t)
          .find(t.filter(tenantId, identityId))
          .lean()
          .exec()) as Record<string, unknown>[];
        return [t.collection, docs.map((doc) => view(doc, identityId))] as const;
      }),
    );
    return Object.fromEntries(found);
  }

  /** Every section the export gives of one identity (the person, or a linked admin identity). */
  private async sections(identityId: string, tenantId: string): Promise<DsarSections> {
    const [
      timeline,
      auditTrail,
      accessReviews,
      accessReviewExclusions,
      entitlements,
      consents,
      records,
    ] = await Promise.all([
      this.userEventModel.find({ userId: identityId }).sort({ timestamp: -1 }).lean().exec(),
      this.auditEventModel.find({ resourceId: identityId }).sort({ timestamp: -1 }).lean().exec(),
      this.reviewItemModel.find({ identityId }).lean().exec(),
      this.reviewExclusionModel.find({ identityId }).lean().exec(),
      // The subject's own grants; the catalog entries of their systems are not their data
      this.identityEntitlements
        .getEntitlements(identityId)
        .then((held) => held?.entitlements ?? []),
      // Expiry is marked on read, so the status is the one of the export's moment
      this.consentService.listConsents(identityId).then((found) =>
        found.map(
          (c): DsarConsent => ({
            purpose: c.purpose,
            status: c.status,
            grantedAt: c.grantedAt,
            revokedAt: c.revokedAt,
            expiresAt: c.expiresAt,
            method: c.method,
          }),
        ),
      ),
      this.scopeRecords(tenantId, identityId),
    ]);
    return {
      timeline: timeline as unknown as Record<string, unknown>[],
      auditTrail: auditTrail as unknown as Record<string, unknown>[],
      accessReviews: accessReviews as unknown as Record<string, unknown>[],
      accessReviewExclusions: accessReviewExclusions as unknown as Record<string, unknown>[],
      entitlements: entitlements as unknown as Record<string, unknown>[],
      consents,
      records,
    };
  }

  /**
   * Export all data held about one identity in a single JSON package: its sections, and the same
   * sections of each linked admin identity (`parentIdentityId`), which a GDPR erasure erases with
   * the person.
   */
  async exportIdentityData(identityId: string, exportedBy: string): Promise<DsarExportPackage> {
    const identity = await this.identityModel.findById(identityId).lean().exec();
    if (!identity) {
      throw new NotFoundException(`Identity ${identityId} not found`);
    }

    const doc = identity as unknown as Record<string, unknown>;
    const profile = doc.profile as Record<string, unknown> | undefined;
    const profileEmail = (profile?.email as string) ?? identityId;
    const tenantId = (doc.tenantId as string) ?? 'unknown';

    const [own, admins] = await Promise.all([
      this.sections(identityId, tenantId),
      this.identityModel.find({ parentIdentityId: identityId }).lean().exec(),
    ]);
    const linkedAdminIdentities = await Promise.all(
      (admins ?? []).map(async (admin) => ({
        identity: admin as unknown as Record<string, unknown>,
        ...(await this.sections(String(admin._id), tenantId)),
      })),
    );

    const ctx = getRequestContext();

    // Emit DATA_EXPORTED audit event
    this.auditService.logFireAndForget({
      action: 'DATA_EXPORTED',
      severity: 'info',
      actor: exportedBy,
      resourceType: 'identity',
      resourceId: identityId,
      resourceName: profileEmail,
      description: `DSAR data export for identity ${profileEmail} (Article 15/20)`,
      payload: {
        metadata: {
          timelineCount: own.timeline.length,
          auditTrailCount: own.auditTrail.length,
          accessReviewCount: own.accessReviews.length,
          accessReviewExclusionCount: own.accessReviewExclusions.length,
          entitlementCount: own.entitlements.length,
          consentCount: own.consents.length,
          recordCounts: Object.fromEntries(
            Object.entries(own.records).map(([collection, docs]) => [collection, docs.length]),
          ),
          linkedAdminIdentityCount: linkedAdminIdentities.length,
        },
      },
      tenantId: ctx?.tenantId ?? tenantId,
    });

    return {
      exportedAt: new Date().toISOString(),
      exportedBy,
      dataSubjectId: identityId,
      identity: doc as Record<string, unknown>,
      ...own,
      linkedAdminIdentities,
      attestation:
        'Generated per GDPR Article 15 — Right of Access and Article 20 — Right to Data Portability',
    };
  }
}
