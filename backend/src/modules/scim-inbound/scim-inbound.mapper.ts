import { Injectable } from '@nestjs/common';
import { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';
import {
  SCIMUser,
  SCIMEnterprise,
  SCIMMeta,
  SCIMGroup,
  SCIM_SCHEMAS,
  SCIMError,
} from '@shared/scim';

/** Profile statuses a SCIM User shows as `active: true`; every other status is inactive. */
export const SCIM_ACTIVE_STATUSES: string[] = [UserStatus.ACTIVE, UserStatus.PENDING];

/** A SCIM member's type: a user or another group (RFC 7643 section 4.2). */
export type ScimMemberType = 'User' | 'Group';

/** A group member as EuroID keeps it: its value, and its type when the IdP sent one. */
export interface ScimMemberRef {
  value: string;
  type?: ScimMemberType;
}

/**
 * A SCIM group's members as its catalog entry stores them: the values in order (scimMembers), and
 * the type of each member the IdP sent one for (scimMemberTypes). A member without one is a user,
 * as before types were kept.
 */
export interface StoredScimMembers {
  scimMembers: string[];
  scimMemberTypes: Array<{ value: string; type: ScimMemberType }>;
}

/** Entitlement catalog entry shape (for group mapping) */
export type EntitlementCatalogEntry = Record<string, unknown> & {
  _id?: { toString: () => string };
  name?: string;
  externalId?: string;
  metadata?: Partial<StoredScimMembers> & { externalId?: string };
  createdAt?: Date;
  updatedAt?: Date;
};

/** `User` or `Group` in any case; any other type is no type (the member is taken as a user). */
function memberType(type: unknown): ScimMemberType | undefined {
  if (typeof type !== 'string') return undefined;
  const lower = type.toLowerCase();
  if (lower === 'group') return 'Group';
  if (lower === 'user') return 'User';
  return undefined;
}

/** A member of a group body or a PATCH value: its value as a string, or `{ value, type }`. */
export function toMemberRef(member: unknown): ScimMemberRef | undefined {
  if (typeof member === 'string') return member ? { value: member } : undefined;
  const { value, type } = (member ?? {}) as { value?: unknown; type?: unknown };
  if (typeof value !== 'string' || !value) return undefined;
  const kind = memberType(type);
  return kind ? { value, type: kind } : { value };
}

/** The members in the form the catalog entry stores them. */
export function toStoredMembers(members: ScimMemberRef[]): StoredScimMembers {
  return {
    scimMembers: members.map((m) => m.value),
    scimMemberTypes: members.flatMap((m) => (m.type ? [{ value: m.value, type: m.type }] : [])),
  };
}

/** The members a catalog entry stores, each with the type it was sent with. */
export function storedMemberRefs(
  metadata: Partial<StoredScimMembers> | undefined,
): ScimMemberRef[] {
  const types = new Map((metadata?.scimMemberTypes ?? []).map((t) => [t.value, t.type]));
  return (metadata?.scimMembers ?? []).map((value) => {
    const type = types.get(value);
    return type ? { value, type } : { value };
  });
}

/** User record from MongoDB (User model or Identity profile) */
export type UserRecord = Record<string, unknown> & {
  _id?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  jobTitle?: string;
  departmentName?: string;
  departmentCode?: string;
  status?: string;
  employeeId?: string;
  division?: string;
  managerEmail?: string;
  mobilePhone?: string;
  workPhone?: string;
  createdAt?: Date;
  updatedAt?: Date;
  sourceUserId?: string;
  profile?: UserRecord;
};

/**
 * Maps SCIM 2.0 User resources to/from EuroID StandardUserDto and user records.
 */
@Injectable()
export class ScimInboundMapper {
  /**
   * Convert inbound SCIMUser to StandardUserDto (partial, for create/update).
   */
  toStandardUser(scimUser: SCIMUser): Partial<StandardUserDto> {
    const enterprise = scimUser['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'];
    const primaryEmail =
      scimUser.emails?.find((e) => e.primary)?.value ?? scimUser.emails?.[0]?.value;
    const email = primaryEmail ?? scimUser.userName;

    const workPhone = scimUser.phoneNumbers?.find((p) => p.type === 'work')?.value;
    const mobilePhone = scimUser.phoneNumbers?.find((p) => p.type === 'mobile')?.value;
    const firstPhone = scimUser.phoneNumbers?.[0]?.value;

    const dto: Partial<StandardUserDto> = {
      firstName: scimUser.name?.givenName ?? '',
      lastName: scimUser.name?.familyName ?? '',
      middleName: scimUser.name?.middleName,
      displayName: scimUser.displayName || scimUser.name?.formatted,
      email,
      userPrincipalName: scimUser.userName,
      jobTitle: scimUser.title,
      status: scimUser.active === false ? UserStatus.INACTIVE : UserStatus.ACTIVE,
      sourceUserId: scimUser.externalId ?? scimUser.userName,
      mobilePhone: mobilePhone ?? (firstPhone && !workPhone ? firstPhone : undefined),
      workPhone,
    };

    if (enterprise) {
      if (enterprise.employeeNumber) dto.employeeId = enterprise.employeeNumber;
      if (enterprise.department) {
        dto.departmentName = enterprise.department;
        dto.departmentCode = enterprise.department;
      }
      if (enterprise.division) dto.division = enterprise.division;
      if (enterprise.organization)
        dto.customAttributes = {
          ...dto.customAttributes,
          company: enterprise.organization,
        };
      if (enterprise.manager?.displayName) dto.managerEmail = enterprise.manager.displayName;
    }

    return this.stripUndefined(dto);
  }

  /**
   * Convert user/identity record to SCIMUser for response.
   */
  toSCIMResponse(user: UserRecord, baseUrl: string): SCIMUser {
    const profile = user.profile ?? user;
    const id = String(user._id ?? profile._id ?? '');
    const schemas: string[] = [SCIM_SCHEMAS.USER];

    const enterprise = this.buildEnterprise(profile);
    if (enterprise) schemas.push(SCIM_SCHEMAS.ENTERPRISE_USER);

    const email = (profile.email as string) ?? (profile.userPrincipalName as string) ?? '';
    const firstName = (profile.firstName as string) ?? '';
    const lastName = (profile.lastName as string) ?? '';
    const displayName =
      (profile.displayName as string) ?? (`${firstName} ${lastName}`.trim() || email);

    const scimUser: SCIMUser = {
      schemas,
      id,
      userName: (profile.userPrincipalName as string) ?? email,
      externalId: (profile.sourceUserId as string) ?? (profile.employeeId as string),
      meta: this.buildMeta(profile, baseUrl, id),
      name: {
        givenName: firstName,
        familyName: lastName,
        middleName: profile.middleName as string,
        formatted: displayName,
      },
      displayName,
      active: SCIM_ACTIVE_STATUSES.includes(profile.status as string),
      title: profile.jobTitle as string,
      emails: email ? [{ value: email, type: 'work', primary: true }] : [],
      phoneNumbers: this.buildPhoneNumbers(profile),
    };

    if (enterprise) {
      scimUser['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'] = enterprise;
    }

    this.stripUndefined(scimUser as unknown as Record<string, unknown>);
    return scimUser;
  }

  private buildMeta(profile: UserRecord, baseUrl: string, id: string): SCIMMeta {
    const created = profile.createdAt;
    const lastModified = (profile.updatedAt ?? profile.lastSyncedAt ?? created) as
      | Date
      | string
      | undefined;
    const location = `${baseUrl.replace(/\/$/, '')}/scim/v2/Users/${id}`;

    return {
      resourceType: 'User',
      created: created ? new Date(created as Date).toISOString() : undefined,
      lastModified: lastModified ? new Date(lastModified).toISOString() : undefined,
      location,
    };
  }

  private buildEnterprise(profile: UserRecord): SCIMEnterprise | null {
    const enterprise: SCIMEnterprise = {};
    let hasFields = false;

    if (profile.employeeId) {
      enterprise.employeeNumber = String(profile.employeeId);
      hasFields = true;
    }
    if (profile.departmentName || profile.departmentCode) {
      enterprise.department = String(profile.departmentName ?? profile.departmentCode);
      hasFields = true;
    }
    if (profile.division) {
      enterprise.division = String(profile.division);
      hasFields = true;
    }
    if (
      profile.customAttributes &&
      typeof profile.customAttributes === 'object' &&
      'company' in profile.customAttributes
    ) {
      enterprise.organization = String(
        (profile.customAttributes as Record<string, unknown>).company,
      );
      hasFields = true;
    }
    if (profile.managerEmail) {
      enterprise.manager = { displayName: String(profile.managerEmail) };
      hasFields = true;
    }

    return hasFields ? enterprise : null;
  }

  private buildPhoneNumbers(
    profile: UserRecord,
  ): Array<{ value: string; type: string }> | undefined {
    const phones: Array<{ value: string; type: string }> = [];
    if (profile.workPhone) phones.push({ value: String(profile.workPhone), type: 'work' });
    if (profile.mobilePhone) phones.push({ value: String(profile.mobilePhone), type: 'mobile' });
    return phones.length > 0 ? phones : undefined;
  }

  private stripUndefined<T extends Record<string, unknown>>(obj: T): T {
    Object.keys(obj).forEach((key) => {
      if (obj[key] === undefined) delete obj[key];
    });
    return obj;
  }

  /**
   * Convert SCIMGroup to entitlement catalog entry for create/update.
   */
  toEntitlementEntry(scimGroup: SCIMGroup): Partial<EntitlementCatalogEntry> & {
    name: string;
    system: string;
    type: 'Group';
  } {
    const members = (scimGroup.members ?? []).flatMap((m) => toMemberRef(m) ?? []);
    const metadata: Record<string, unknown> = { ...toStoredMembers(members) };
    if (scimGroup.externalId) metadata.externalId = scimGroup.externalId;

    const entry: Partial<EntitlementCatalogEntry> & {
      name: string;
      system: string;
      type: 'Group';
    } = {
      name: scimGroup.displayName,
      system: 'scim-inbound',
      type: 'Group',
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
    return this.stripUndefined(entry) as typeof entry;
  }

  /**
   * Build a full StandardUserDto from a partial SCIM-mapped DTO, filling defaults from existing record.
   */
  buildFullDto(
    partial: Partial<StandardUserDto>,
    email: string,
    existing?: Record<string, unknown>,
  ): StandardUserDto {
    const base = existing ?? {};
    return {
      sourceSystem:
        (partial.sourceSystem as string) ?? (base.sourceSystem as string) ?? 'SCIM-INBOUND',
      sourceUserId: (partial.sourceUserId as string) ?? (base.sourceUserId as string) ?? email,
      tenantId: (partial.tenantId as string) ?? (base.tenantId as string) ?? 'default',
      firstName: (partial.firstName as string) ?? (base.firstName as string) ?? '',
      lastName: (partial.lastName as string) ?? (base.lastName as string) ?? '',
      email,
      status: (partial.status as UserStatus) ?? (base.status as UserStatus) ?? UserStatus.ACTIVE,
      ...partial,
    } as StandardUserDto;
  }

  /** Allowed SCIM PATCH paths — reject unknown paths to prevent arbitrary key injection (IV-1). */
  private static readonly PATCH_PATH_ALLOWLIST = new Set([
    'userName',
    'name.givenName',
    'name.familyName',
    'displayName',
    'active',
    'title',
    'emails',
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department',
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber',
  ]);

  private static readonly SCIM_TO_DTO: Record<string, string> = {
    userName: 'email',
    'name.givenName': 'firstName',
    'name.familyName': 'lastName',
    displayName: 'displayName',
    active: 'status',
    title: 'jobTitle',
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department': 'departmentName',
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber': 'employeeId',
  };

  /** PATCH paths whose attribute an identity must have: a remove of one is refused. */
  private static readonly REQUIRED_PATCH_PATHS = new Set([
    'userName',
    'emails',
    'name.givenName',
    'name.familyName',
    'active',
  ]);

  /**
   * The fields SCIM PATCH operations change, as a partial StandardUserDto: only what the
   * operations name, so an operation that repeats a value changes nothing. Add and replace set
   * the attribute (add on a single-valued attribute replaces it, RFC 7644 section 3.5.2.1); remove
   * clears it (null). Removing an attribute an identity must have is refused (400, mutability).
   * Only explicitly mapped paths are allowed; an unknown path is refused (arbitrary key
   * injection). `_current` is the record the operations apply to (kept for callers).
   */
  applyPatchOps(
    _current: Record<string, unknown>,
    ops: Array<{ op: string; path?: string; value?: unknown }>,
  ): Partial<StandardUserDto> {
    const result: Record<string, unknown> = {};
    const { PATCH_PATH_ALLOWLIST, SCIM_TO_DTO, REQUIRED_PATCH_PATHS } = ScimInboundMapper;

    for (const op of ops) {
      const path = op.path ?? '';
      if (!path) {
        throw new SCIMError('invalidValue', 'PATCH operation requires a path', '400');
      }
      if (!PATCH_PATH_ALLOWLIST.has(path)) {
        throw new SCIMError(
          'invalidValue',
          `Unsupported PATCH path: ${path}. Supported: userName, name.givenName, name.familyName, displayName, active, title, emails, enterprise extension`,
          '400',
        );
      }

      const field =
        SCIM_TO_DTO[path] ??
        path.replace(/^urn:ietf:params:scim:schemas:extension:enterprise:2\.0:User:/, '');
      const value = op.value;

      if (op.op === 'remove') {
        if (REQUIRED_PATCH_PATHS.has(path)) {
          throw new SCIMError('mutability', `${path} is required and cannot be removed`, '400');
        }
        result[field] = null;
      } else if (path === 'active') {
        result.status =
          value === true || value === 'true' ? UserStatus.ACTIVE : UserStatus.INACTIVE;
      } else if (path === 'emails') {
        const emails = Array.isArray(value)
          ? (value as Array<{ primary?: boolean; value?: string }>)
          : [];
        const primary = emails.find((e) => e?.primary) ?? emails[0];
        if (primary?.value) result.email = primary.value;
      } else if (value !== undefined) {
        result[field] = value;
      }
    }

    return result as Partial<StandardUserDto>;
  }

  /**
   * Convert entitlement catalog entry to SCIMGroup response.
   */
  toSCIMGroupResponse(entry: EntitlementCatalogEntry, baseUrl: string): SCIMGroup {
    const id = entry._id?.toString?.() ?? String(entry._id ?? '');
    const meta = entry.metadata as Record<string, unknown> | undefined;
    const externalId = meta?.externalId as string | undefined;
    // A member the IdP sent as a Group is returned as one; any other member as a User
    const members = storedMemberRefs(entry.metadata).map(({ value, type = 'User' }) => ({
      value,
      $ref: `${baseUrl.replace(/\/$/, '')}/scim/v2/${type === 'Group' ? 'Groups' : 'Users'}/${value}`,
      type,
    }));

    return {
      schemas: [SCIM_SCHEMAS.GROUP],
      id,
      externalId: externalId ?? (entry.externalId as string | undefined),
      displayName: (entry.name as string) ?? '',
      members: members.length > 0 ? members : undefined,
      meta: {
        resourceType: 'Group',
        created: entry.createdAt ? new Date(entry.createdAt as Date).toISOString() : undefined,
        lastModified: entry.updatedAt ? new Date(entry.updatedAt as Date).toISOString() : undefined,
        location: `${baseUrl.replace(/\/$/, '')}/scim/v2/Groups/${id}`,
      },
    };
  }
}
