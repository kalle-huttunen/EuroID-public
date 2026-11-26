/**
 * The tenant's identity limit: `settings.maxIdentities` of its `tenants` document, the most live
 * (not soft-deleted) identities the tenant may have. Unset, or anything but a positive integer, is
 * no limit. It is checked where a record would mint a new identity
 * (IdentityCorrelationService.ensureIdentityFromUser), so every creating path is held to it: HR
 * ingest, SCIM create, POST /identity, bulk and batch provisioning. An update, a rehire (it revives
 * a deleted identity) and a correlation onto an existing identity mint nothing and are never
 * refused. Identities made outside correlation (linked admin accounts, the identities of console
 * admins) are not refused either; they count as live identities.
 *
 * The count and the insert are separate steps, so creates running at the same moment can pass
 * the limit by the number running. That is accepted (the cap is a license control, and a lock per
 * create would serialise every HR sync), but never unnoticed: reportIdentityLimitOvershoot raises
 * one alert per overshoot. docs/architecture/infrastructure/ARCHITECTURE_MULTI_TENANCY.md.
 */
import { HttpStatus } from '@nestjs/common';
import type { ClientSession, Model } from 'mongoose';
import { IdentityException } from '@shared/exceptions/domain-exceptions';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { NOT_DELETED } from './identity.constants';
import type { IdentityDocument } from './schemas/identity.schema';
import { Tenant, TenantSchema } from '@infrastructure/multi-tenancy/schemas/tenant.schema';

/** No identity was created: the tenant has `limit` live identities already. */
export class IdentityLimitReached extends IdentityException {
  constructor(readonly limit: number) {
    super(
      `The tenant's identity limit (${limit}) is reached: no identity was created. A platform ` +
        'admin can raise Max Identities on the tenant, or delete identities that are no longer needed.',
      HttpStatus.CONFLICT,
    );
  }
}

/** The tenant's limit, or undefined for none. Read from `tenants` directly (no tenant scope). */
async function identityLimitOf(
  identityModel: Model<IdentityDocument>,
  tenantId: string,
  session?: ClientSession,
): Promise<number | undefined> {
  const tenant = await identityModel.db
    .collection('tenants')
    .findOne(
      { tenantId },
      { projection: { 'settings.maxIdentities': 1 }, ...(session ? { session } : {}) },
    );
  const limit: unknown = tenant?.settings?.maxIdentities;
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

/** IdentityLimitReached when the tenant has as many live identities as its limit allows. */
export async function assertRoomForNewIdentity(
  identityModel: Model<IdentityDocument>,
  tenantId: string,
  session?: ClientSession,
): Promise<void> {
  const limit = await identityLimitOf(identityModel, tenantId, session);
  if (limit === undefined) return;
  let count = identityModel.countDocuments({ tenantId, ...NOT_DELETED });
  if (session) count = count.session(session);
  if ((await count.exec()) >= limit) throw new IdentityLimitReached(limit);
}

/** What a check found: the limit and the live count, and whether this check raised the alert. */
export interface IdentityLimitCheck {
  limit: number;
  count: number;
  alerted: boolean;
}

/**
 * When the tenant's live identities exceed its limit (creates running at the same moment passed
 * the count), one `tenant.identity_limit_exceeded` event names the limit and the count; it is
 * audited and webhooks can subscribe to it. The tenants document's `identityLimitExceededAt`
 * keeps it to one until a check finds the count within the limit again, which clears it.
 * Runs after every mint outside a transaction (ensureIdentityFromUser: the insert is committed)
 * and in the hourly sweep. A mint inside a transaction (`session` in one) is left to the sweep and
 * answers undefined: the transaction may still abort (a duplicate email), and the flag and the
 * event, written outside it, would then stand for an identity that never committed. The sweep
 * counts only committed identities, so it also catches creates whose transactions could not see
 * each other. Undefined when the tenant has no limit.
 */
export async function reportIdentityLimitOvershoot(
  identityModel: Model<IdentityDocument>,
  eventEmitter: Pick<DomainEventEmitterService, 'emit'>,
  tenantId: string,
  session?: ClientSession,
): Promise<IdentityLimitCheck | undefined> {
  if (session?.inTransaction()) return undefined;
  const limit = await identityLimitOf(identityModel, tenantId);
  if (limit === undefined) return undefined;
  const count = await identityModel.countDocuments({ tenantId, ...NOT_DELETED }).exec();
  // The tenants schema opts out of the tenant plugin: tenantId is the document's own key here
  const tenants: Model<Tenant> =
    identityModel.db.models[Tenant.name] ?? identityModel.db.model(Tenant.name, TenantSchema);
  if (count <= limit) {
    await tenants
      .updateOne(
        { tenantId, identityLimitExceededAt: { $exists: true } },
        { $unset: { identityLimitExceededAt: '' } },
      )
      .exec();
    return { limit, count, alerted: false };
  }
  const claimed = await tenants
    .updateOne(
      { tenantId, identityLimitExceededAt: { $exists: false } },
      { $set: { identityLimitExceededAt: new Date() } },
    )
    .exec();
  const alerted = claimed.modifiedCount > 0;
  if (alerted) {
    eventEmitter.emit(DomainEventType.TENANT_IDENTITY_LIMIT_EXCEEDED, tenantId, { limit, count });
  }
  return { limit, count, alerted };
}
