import { ForbiddenException, Injectable, Module } from '@nestjs/common';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Tenant, TenantDocument, TenantSchema } from './schemas/tenant.schema';

/** What a sign-in, a token refresh or a request of a suspended or deprovisioned tenant answers (403). */
export const TENANT_INACTIVE_MESSAGE =
  'This tenant is suspended. Contact your platform administrator.';

const DEFAULT_CACHE_MS = 30_000;

/** Whether a tenant with this `tenants` document may use EuroID: active, or no document at all. */
export function tenantAllowsUse(doc: { status?: string } | null | undefined): boolean {
  return !doc || (doc.status ?? 'active') === 'active';
}

/**
 * Whether a tenant may use EuroID. A tenant whose `tenants` document has a status other than
 * `active` (suspended, deprovisioned) is refused at sign-in, at token refresh, on every
 * authenticated request and websocket, and its webhooks are not delivered. A tenant with no
 * `tenants` document (a single-tenant deployment's DEFAULT_TENANT_ID) is active.
 *
 * Statuses are cached per process for TENANT_STATUS_CACHE_MS (30 s by default): a suspension
 * applies at once on the instance that made it (TenantService calls forget()) and within that
 * time on every other instance.
 */
@Injectable()
export class TenantStatusService {
  private readonly cache = new Map<string, { active: boolean; expiresAt: number }>();
  private readonly cacheMs: number;

  constructor(@InjectModel(Tenant.name) private readonly tenantModel: Model<TenantDocument>) {
    const configured = Number(process.env.TENANT_STATUS_CACHE_MS);
    this.cacheMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_CACHE_MS;
  }

  async isActive(tenantId: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > now) return cached.active;
    const doc = await this.tenantModel
      .findOne({ tenantId }, 'status')
      .lean<{ status?: string } | null>();
    const active = tenantAllowsUse(doc);
    this.cache.set(tenantId, { active, expiresAt: now + this.cacheMs });
    return active;
  }

  /** ForbiddenException (403) unless the tenant is active. */
  async assertActive(tenantId: string): Promise<void> {
    if (!(await this.isActive(tenantId))) {
      throw new ForbiddenException(TENANT_INACTIVE_MESSAGE);
    }
  }

  /** Drop the cached status of `tenantId` (after its status changed on this instance). */
  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}

/**
 * Provides the one TenantStatusService of the process. A module of its own, so the auth module,
 * the tenant module and the webhook delivery can all import it without importing each other.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: Tenant.name, schema: TenantSchema }])],
  providers: [TenantStatusService],
  exports: [TenantStatusService],
})
export class TenantStatusModule {}
