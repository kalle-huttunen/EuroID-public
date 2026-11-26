import { BadRequestException, ConflictException } from '@nestjs/common';
import { StandardUserDto, EmploymentContract } from '@shared/dtos/standard-user.dto';
import type { IdentityDocument, LinkedAccount } from './schemas/identity.schema';
import { MAX_SOURCES } from './identity.constants';

/**
 * Structural type for identity-shaped documents passed to projectIdentityToUser.
 * Accepts both hydrated Mongoose documents and lean POJOs.
 */
export type IdentityLike = IdentityDocument | IdentityPlainObject;

interface IdentityPlainObject {
  _id?: { toString(): string } | string;
  profile?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tenantId?: string;
  sources?: Array<{ sourceName: string; externalId: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Deduplicate sources by (sourceName, externalId) and enforce max length.
 */
export function deduplicateAndValidateSources(sources: LinkedAccount[]): LinkedAccount[] {
  const seen = new Set<string>();
  const deduped = sources.filter((s) => {
    const key = `${s.sourceName}:${s.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length > MAX_SOURCES) {
    throw new BadRequestException(
      `Identity sources array exceeds maximum of ${MAX_SOURCES} entries`,
    );
  }
  return deduped;
}

/**
 * The entry of `sources` an incoming record of `sourceName`/`externalId` replaces: the one with
 * that source key, else the only entry of that source (its key changed, e.g. a re-keyed HR
 * record); -1 to add it. An identity holding several records of one source (a Merge or Link of
 * two such identities) keeps each: a sync replaces only its own.
 */
export function sourceEntryIndex(
  sources: Array<{ sourceName: string; externalId: string }>,
  sourceName: string,
  externalId: string,
): number {
  const exact = sources.findIndex(
    (s) => s.sourceName === sourceName && s.externalId === externalId,
  );
  if (exact >= 0) return exact;
  const named = sources.flatMap((s, i) => (s.sourceName === sourceName ? [i] : []));
  return named.length === 1 ? named[0] : -1;
}

/**
 * Retry find-modify-save on VersionError (optimistic concurrency conflict).
 * Reloads, re-applies modifier, and retries up to maxAttempts times. `persist` replaces the
 * plain save (it must save the document once, e.g. reconcile it) and its result is returned.
 */
export async function saveWithRetry<T extends { save(): Promise<unknown> }>(
  load: () => Promise<T | null>,
  modify: (doc: T) => void,
  context: string,
  logger: { warn: (msg: string) => void },
  maxAttempts = 3,
  persist?: (doc: T) => Promise<T>,
): Promise<T | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const doc = await load();
    if (!doc) return null;
    modify(doc);
    try {
      if (persist) return await persist(doc);
      await doc.save();
      return doc;
    } catch (err: unknown) {
      const isVersionError =
        err &&
        typeof err === 'object' &&
        'name' in err &&
        (err as { name: string }).name === 'VersionError';
      if (isVersionError) {
        logger.warn(`${context}: concurrent update, retry ${attempt + 1}/${maxAttempts}`);
        continue;
      }
      throw err;
    }
  }
  throw new ConflictException('Failed to update after max retries due to concurrent modifications');
}

/**
 * Backfill tenantId on the Identity. Its sources, controls and provisioning entries belong to its
 * tenant and carry none (the tenant plugin leaves embedded schemas alone).
 */
export function ensureTenantId(identity: IdentityDocument, fallbackTenantId: string): void {
  if (!identity.tenantId) identity.tenantId = fallbackTenantId;
}

/**
 * Primary Calculator: copy primary contract's title and department to root.
 */
export function computePrimaryFromContracts(user: StandardUserDto | Record<string, unknown>): void {
  const rec = user as Record<string, unknown>;
  const contracts = rec.contracts;
  if (!Array.isArray(contracts) || contracts.length === 0) return;

  const typedContracts = contracts as EmploymentContract[];
  const primary = typedContracts.find((c) => c?.isPrimary === true) ?? typedContracts[0];
  rec.jobTitle = primary.title;
  rec.departmentCode = primary.department;
  rec.departmentName = primary.department;
}

/**
 * Project Identity document to User-like shape for API responses.
 * Returns untyped for backward compatibility with existing callers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- existing callers rely on dynamic access
export function projectIdentityToUser(doc: IdentityLike): any {
  const raw = isHydratedDocument(doc) ? doc.toObject() : doc;
  const obj = raw as IdentityPlainObject;
  return {
    ...(obj.profile || {}),
    _id: obj._id?.toString(),
    metadata: obj.metadata,
    tenantId: obj.tenantId,
  };
}

function isHydratedDocument(doc: IdentityLike): doc is IdentityDocument {
  return typeof (doc as IdentityDocument).toObject === 'function';
}

/** Convert StandardUserDto to profile object for new Identity creation. */
export function dtoToProfile(dto: StandardUserDto): Record<string, unknown> {
  const p = { ...dto } as Record<string, unknown>;
  p.sourceSystem = dto.sourceSystem;
  p.sourceUserId = dto.sourceUserId;
  p.tenantId = dto.tenantId;
  return p;
}

/** The profile of an identity as a plain object (a hydrated profile is a subdocument). */
export function profileOf(identity: IdentityDocument): Record<string, unknown> {
  const plain = typeof identity.toObject === 'function' ? identity.toObject() : identity;
  return ((plain as { profile?: unknown }).profile ?? {}) as Record<string, unknown>;
}

/**
 * The profile an edit is compared with: while the kill switch is on, its status is the one the
 * switch keeps (metadata.statusUnderKillSwitch), which a PATCHed status replaces; the stored
 * status stays SUSPENDED.
 */
export function profileUnderKillSwitch(identity: IdentityDocument): Record<string, unknown> {
  const profile = profileOf(identity);
  if (identity.controls?.isLoginDisabled !== true) return profile;
  const kept = (identity.metadata as { statusUnderKillSwitch?: string | null } | undefined)
    ?.statusUnderKillSwitch;
  return { ...profile, status: kept ?? undefined };
}

const isBlank = (value: unknown) => value === undefined || value === null || value === '';

/** The fields of `updates` whose value differs from the profile's (empty counts as empty). */
export function changedProfileFields(
  profile: Record<string, unknown>,
  updates: Record<string, unknown>,
): string[] {
  return Object.keys(updates).filter((field) => {
    const before = profile[field];
    const after = updates[field];
    if (isBlank(before) && isBlank(after)) return false;
    return JSON.stringify(before) !== JSON.stringify(after);
  });
}
