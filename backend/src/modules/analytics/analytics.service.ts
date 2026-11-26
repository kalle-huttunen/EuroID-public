/**
 * Predictive Analytics Service
 *
 * Pre-computes offboarding blast radius, license consumption forecasting,
 * and seasonal onboarding pattern detection.
 */

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import {
  UpcomingOffboarding,
  UpcomingOffboardingDocument,
} from './schemas/upcoming-offboarding.schema';
import {
  EntitlementCatalog,
  EntitlementCatalogDocument,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { AuditEvent, AuditEventDocument } from '../audit/schemas/audit-event.schema';
import { Identity, IdentityDocument, IdentityProfile } from '../identity/schemas/identity.schema';
import { IdentityService } from '../identity/identity.service';
import { PolicyEngineService } from '../policy/policy-engine.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { PolicyProvisioningIntent } from '../policy/policy-engine.service';
import type { BlastRadius, BlastRadiusRiskLevel } from './schemas/upcoming-offboarding.schema';
import { forecastLicense, type LicenseForecastResult, type LicenseUnits } from './license-forecast';

export type { LicenseForecastResult } from './license-forecast';

const ADMIN_KEYWORDS = ['admin', 'root', 'super', 'elevated', 'privileged'];

export interface UpcomingOffboardingResult {
  identityId: string;
  email: string;
  displayName: string;
  endDate: Date;
  daysRemaining: number;
  blastRadius: BlastRadius;
  computedAt: Date;
  stale: boolean;
}

export interface SeasonalPatternResult {
  month: number;
  year: number;
  averageOnboardings: number;
  peakOnboardings: number;
  isAnomalous: boolean;
  label?: string;
}

/** An identity as identitiesEnding reads it. */
interface OffboardingIdentity {
  _id: { toString(): string };
  profile?: unknown;
}

/** The identity's profile.endDate as a Date. */
function endDateOf(doc: OffboardingIdentity): Date {
  const raw = ((doc.profile ?? {}) as IdentityProfile).endDate;
  return raw instanceof Date ? raw : new Date(raw as unknown as string | number);
}

/** Whole days from `now` until `date`, rounded up. */
function daysUntil(date: Date, now: Date): number {
  return Math.ceil((date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}

@Injectable()
export class PredictiveAnalyticsService {
  private readonly logger = this.loggerFactory.create(PredictiveAnalyticsService.name);

  constructor(
    @InjectModel(UpcomingOffboarding.name)
    private readonly offboardingModel: Model<UpcomingOffboardingDocument>,
    @InjectModel(EntitlementCatalog.name)
    private readonly catalogModel: Model<EntitlementCatalogDocument>,
    @InjectModel(AuditEvent.name)
    private readonly auditModel: Model<AuditEventDocument>,
    @InjectModel(Identity.name)
    private readonly identityModel: Model<IdentityDocument>,
    private readonly identityService: IdentityService,
    private readonly policyEngine: PolicyEngineService,
    private readonly config: ConfigService,
    private readonly loggerFactory: LoggerFactoryService,
  ) {}

  /**
   * Compute (and cache) the blast radius of every live identity whose endDate is within
   * daysAhead: POST /analytics/refresh, and GET /analytics/upcoming-offboardings with refresh.
   */
  async preComputeUpcomingOffboardings(
    daysAhead: number = 30,
  ): Promise<UpcomingOffboardingResult[]> {
    const now = new Date();
    const tenantId = getRequestContext()?.tenantId || 'default';
    const results: UpcomingOffboardingResult[] = [];
    for (const doc of await this.identitiesEnding(now, daysAhead, tenantId)) {
      results.push(await this.computeOffboarding(doc, now, tenantId));
    }
    this.logger.log(`Pre-computed ${results.length} upcoming offboardings`);
    return results;
  }

  /**
   * The live identities whose endDate is within daysAhead, read on every call: the list holds a
   * leaver whose endDate was set after an earlier compute and drops one whose endDate moved out.
   * The blast radius (a policy evaluation each) comes from the cache while the cached entry is
   * not stale and has the same endDate; otherwise it is computed and cached. daysRemaining is
   * counted now. `refresh` computes every entry again.
   */
  async getUpcomingOffboardings(
    daysAhead: number = 30,
    refresh?: boolean,
  ): Promise<UpcomingOffboardingResult[]> {
    if (refresh) {
      return this.preComputeUpcomingOffboardings(daysAhead);
    }

    const now = new Date();
    const tenantId = getRequestContext()?.tenantId || 'default';
    const identities = await this.identitiesEnding(now, daysAhead, tenantId);
    if (identities.length === 0) return [];

    const ids = identities.map((doc) => doc._id.toString());
    const cached = await this.offboardingModel
      .find({ tenantId, identityId: { $in: ids }, stale: false })
      .lean()
      .exec();
    const cachedById = new Map(cached.map((entry) => [entry.identityId, entry]));

    const results: UpcomingOffboardingResult[] = [];
    for (const doc of identities) {
      const endDate = endDateOf(doc);
      const entry = cachedById.get(doc._id.toString());
      if (entry && new Date(entry.endDate).getTime() === endDate.getTime()) {
        results.push({
          identityId: entry.identityId,
          email: entry.email,
          displayName: entry.displayName || entry.email,
          endDate: entry.endDate,
          daysRemaining: daysUntil(endDate, now),
          blastRadius: entry.blastRadius,
          computedAt: entry.computedAt,
          stale: false,
        });
      } else {
        results.push(await this.computeOffboarding(doc, now, tenantId));
      }
    }
    return results.sort((a, b) => a.daysRemaining - b.daysRemaining);
  }

  /** Live identities of the tenant whose profile.endDate is between now and daysAhead. */
  private identitiesEnding(
    now: Date,
    daysAhead: number,
    tenantId: string,
  ): Promise<OffboardingIdentity[]> {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() + daysAhead);
    return this.identityModel
      .find({
        tenantId,
        deletedAt: null,
        'profile.endDate': { $exists: true, $ne: null, $gte: now, $lte: cutoff },
      })
      .lean()
      .exec() as Promise<OffboardingIdentity[]>;
  }

  /** The identity's blast radius, computed now and cached. */
  private async computeOffboarding(
    doc: OffboardingIdentity,
    now: Date,
    tenantId: string,
  ): Promise<UpcomingOffboardingResult> {
    const profile = (doc.profile ?? {}) as IdentityProfile;
    const endDate = endDateOf(doc);
    const dto = this.profileToStandardDto({ ...profile, _id: doc._id });
    const blastRadius = await this.computeBlastRadius(dto);

    const result: UpcomingOffboardingResult = {
      identityId: doc._id.toString(),
      email: profile.email,
      displayName:
        profile.displayName ||
        `${profile.firstName || ''} ${profile.lastName || ''}`.trim() ||
        profile.email,
      endDate,
      daysRemaining: daysUntil(endDate, now),
      blastRadius,
      computedAt: new Date(),
      stale: false,
    };

    await this.offboardingModel.findOneAndUpdate(
      { identityId: result.identityId, tenantId },
      { $set: { ...result, tenantId } },
      { upsert: true, new: true },
    );
    return result;
  }

  /**
   * Get single identity blast radius.
   */
  async getUpcomingOffboardingByIdentity(
    identityId: string,
  ): Promise<UpcomingOffboardingResult | null> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    const cached = await this.offboardingModel
      .findOne({ identityId, tenantId, stale: false })
      .lean()
      .exec();
    if (cached) {
      return {
        identityId: cached.identityId,
        email: cached.email,
        displayName: cached.displayName || cached.email,
        endDate: cached.endDate,
        daysRemaining: cached.daysRemaining,
        blastRadius: cached.blastRadius,
        computedAt: cached.computedAt,
        stale: cached.stale,
      };
    }

    const user = await this.identityService.findById(identityId);
    if (!user) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- user is a dynamic lean doc from identity service
    const u = user as any;
    const endDate = u.endDate ? new Date(u.endDate) : null;
    if (!endDate || endDate < new Date()) return null;

    const now = new Date();
    const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    const dto = this.profileToStandardDto(user);
    const blastRadius = await this.computeBlastRadius(dto);

    return {
      identityId,
      email: u.email,
      displayName: u.displayName || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
      endDate,
      daysRemaining,
      blastRadius,
      computedAt: new Date(),
      stale: false,
    };
  }

  /**
   * Forecast a license's consumption: the units in use and enabled as discovery last read them
   * (the catalog entry's licenseUnits; unknown, null, until discovery has run), and the trend of
   * the net adds minus removes EuroID recorded (license-forecast.ts).
   */
  async forecastLicenseConsumption(
    system: string,
    licenseName: string,
    daysAhead: number = 90,
  ): Promise<LicenseForecastResult> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    const entry = await this.catalogModel
      .findOne({
        tenantId,
        system,
        type: 'License',
        $or: [{ nativeId: licenseName }, { name: licenseName }],
      })
      .lean()
      .exec();
    return this.forecastFor(system, licenseName, daysAhead, entry?.licenseUnits);
  }

  private async forecastFor(
    system: string,
    licenseName: string,
    daysAhead: number,
    units: LicenseUnits | undefined,
  ): Promise<LicenseForecastResult> {
    const monthsOfHistory = 6;
    const history = await this.getLicenseProvisioningHistory(system, licenseName, monthsOfHistory);
    return forecastLicense({
      system,
      license: licenseName,
      history,
      monthsOfHistory,
      daysAhead,
      units,
      configuredCap: this.getLicenseCap(system, licenseName),
    });
  }

  /**
   * Get license summary for all systems/licenses, sorted by daysToCapacity ascending.
   */
  async getLicenseSummary(daysAhead: number = 90): Promise<LicenseForecastResult[]> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    const catalog = await this.catalogModel.find({ type: 'License', tenantId }).lean().exec();
    const uniqueBySystemLicense = new Map<
      string,
      { system: string; name: string; units?: LicenseUnits }
    >();
    for (const e of catalog) {
      uniqueBySystemLicense.set(`${e.system}:${e.name}`, {
        system: e.system,
        name: e.name,
        units: e.licenseUnits,
      });
    }

    const forecasts: LicenseForecastResult[] = [];
    for (const { system, name, units } of uniqueBySystemLicense.values()) {
      forecasts.push(await this.forecastFor(system, name, daysAhead, units));
    }

    return forecasts.sort((a, b) => {
      const aDays = a.daysToCapacity ?? Infinity;
      const bDays = b.daysToCapacity ?? Infinity;
      return aDays - bDays;
    });
  }

  /**
   * Detect seasonal onboarding patterns from identity.created events.
   */
  async detectSeasonalPatterns(): Promise<SeasonalPatternResult[]> {
    const monthsNeeded = 12;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - monthsNeeded);

    const tenantId = getRequestContext()?.tenantId || 'default';
    const byMonth = await this.auditModel
      .aggregate([
        { $match: { action: 'identity.created', tenantId, timestamp: { $gte: cutoff } } },
        {
          $group: {
            _id: {
              year: { $year: '$timestamp' },
              month: { $month: '$timestamp' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ])
      .exec();

    const avg = byMonth.length > 0 ? byMonth.reduce((s, m) => s + m.count, 0) / byMonth.length : 0;

    const threshold = avg * 2;

    const labels: Record<string, string> = {
      '6': 'Intern wave',
      '7': 'Intern wave',
      '1': 'Fiscal year start',
      '9': 'Back to school',
    };

    return byMonth.map((m) => {
      const month = m._id.month;
      const year = m._id.year;
      const isAnomalous = m.count >= threshold;
      return {
        month,
        year,
        averageOnboardings: Math.round(avg),
        peakOnboardings: m.count,
        isAnomalous,
        label: labels[String(month)],
      };
    });
  }

  /**
   * Mark pre-computed offboarding as stale when identity is updated.
   */
  async markOffboardingStale(identityId: string): Promise<void> {
    const tenantId = getRequestContext()?.tenantId || 'default';
    await this.offboardingModel
      .updateMany({ identityId, tenantId }, { $set: { stale: true } })
      .exec();
    this.logger.debug(`Marked offboarding cache stale for identity ${identityId}`);
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** Accepts flat user/profile shape (Identity.profile or projected User-like). */
  private profileToStandardDto(user: Record<string, unknown>): StandardUserDto {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic lean doc projected from identity hub
    const u = user as any;
    return {
      sourceSystem: u.sourceSystem || 'hr-feed',
      sourceUserId: u.sourceUserId || u.email,
      tenantId: u.tenantId || 'default',
      firstName: u.firstName || '',
      lastName: u.lastName || '',
      email: u.email,
      displayName: u.displayName,
      jobTitle: u.jobTitle,
      departmentCode: u.departmentCode,
      departmentName: u.departmentName,
      employmentType: u.employmentType,
      status: u.status || 'ACTIVE',
      startDate: u.startDate,
      endDate: u.endDate,
      location: u.location,
      countryCode: u.countryCode,
      _id: u._id?.toString(),
    } as StandardUserDto;
  }

  private async computeBlastRadius(dto: StandardUserDto): Promise<BlastRadius> {
    const intent: PolicyProvisioningIntent = await this.policyEngine.evaluate(dto);

    const affectedSystems = new Set<string>();
    const entitlements: Array<{ system: string; name: string; type: string }> = [];

    for (const op of intent.operations) {
      if (op.type === 'group' || op.type === 'license') {
        const system = op.target || 'unknown';
        affectedSystems.add(system);
        entitlements.push({
          system,
          name: op.targetId || '',
          type: op.type,
        });
      }
    }

    return {
      affectedSystems: [...affectedSystems],
      entitlements,
      totalEntitlements: entitlements.length,
      riskLevel: this.computeRiskLevel(entitlements),
    };
  }

  private computeRiskLevel(
    entitlements: Array<{ name: string; type: string }>,
  ): BlastRadiusRiskLevel {
    if (entitlements.length === 0) return 'low';
    if (entitlements.length > 10) return 'high';

    const hasAdmin = entitlements.some((e) =>
      ADMIN_KEYWORDS.some((k) => (e.name || '').toLowerCase().includes(k)),
    );
    if (hasAdmin) return 'high';

    return entitlements.length > 5 ? 'medium' : 'low';
  }

  /**
   * The license's net adds minus removes EuroID recorded (provisioning.completed audit entries),
   * cumulated over every calendar month from `months` ago to now: a month without changes is in
   * the list with the count it ended at, `changed` false. The count starts at 0 at the start of
   * the window: it is the net change in the window (the forecast's trend), not the consumption.
   */
  private async getLicenseProvisioningHistory(
    system: string,
    licenseName: string,
    months: number,
  ): Promise<Array<{ month: number; year: number; count: number; changed: boolean }>> {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - months);

    // Match connector in payload.metadata (audit stores full event payload there)
    const tenantId = getRequestContext()?.tenantId || 'default';
    const events = await this.auditModel
      .find({
        tenantId,
        action: 'provisioning.completed',
        $or: [{ targetSystem: system }, { 'payload.metadata.connector': system }],
        'payload.metadata.operations': { $exists: true },
        timestamp: { $gte: cutoff },
      })
      .sort({ timestamp: 1 })
      .lean()
      .exec();

    const monthKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;
    const netByMonth = new Map<string, number>();
    for (const e of events) {
      const meta = e.payload?.metadata;
      const ops = (meta?.operations || []) as Record<string, unknown>[];
      const licenseOps = ops.filter(
        (o: Record<string, unknown>) =>
          (o.type === 'license' || o.type === 'License') &&
          (o.targetId === licenseName ||
            String(o.targetId).toLowerCase() === licenseName.toLowerCase()),
      );
      if (licenseOps.length === 0) continue;
      const key = monthKey(new Date(e.timestamp));
      const net = licenseOps.reduce((sum, op) => sum + (op.action === 'add' ? 1 : -1), 0);
      netByMonth.set(key, (netByMonth.get(key) ?? 0) + net);
    }

    const history: Array<{ month: number; year: number; count: number; changed: boolean }> = [];
    let cumulative = 0;
    for (
      const month = new Date(cutoff.getFullYear(), cutoff.getMonth(), 1);
      month <= now;
      month.setMonth(month.getMonth() + 1)
    ) {
      const key = monthKey(month);
      cumulative += netByMonth.get(key) ?? 0;
      history.push({
        month: month.getMonth() + 1,
        year: month.getFullYear(),
        count: cumulative,
        changed: netByMonth.has(key),
      });
    }
    return history;
  }

  private getLicenseCap(system: string, licenseName: string): number | null {
    const caps = this.config.get<Record<string, Record<string, number>>>('LICENSE_CAPS') || {};
    return caps[system]?.[licenseName] ?? null;
  }
}
