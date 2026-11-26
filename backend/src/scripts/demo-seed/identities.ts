/**
 * Identity documents (the onion: profile, sources, provisioning, baseline, metadata) of the demo
 * people. The profile is a StandardUserDto checked by the app's own schema and turned into a
 * profile by the app's helper, as an HR ingest would store it.
 */
import { StandardUserSchema, UserPriority, UserStatus } from '@shared/dtos/standard-user.dto';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { dtoToProfile } from '@modules/identity/identity-helpers';
import type { LinkedAccount } from '@modules/identity/schemas/identity.schema';
import { toAccessBaseline } from '@shared/utils/access-baseline';
import { daysFrom, isoDay, type SeededRandom } from './random';
import { PRIMARY_HR, SECONDARY_HR } from './pools';
import type { DemoPerson } from './people';
import { identityId, managerOf, sectionRandom, type SeedContext } from './context';
import {
  buildProvisioning,
  entraObjectId,
  planProvisioning,
  type ProvisioningPlan,
} from './provisioning';

const UNLINKED = ['uncorrelated', 'ambiguous'];

function statusOf(person: DemoPerson): UserStatus {
  if (person.lifecycle === 'terminated' || person.lifecycle === 'soft-deleted') {
    return UserStatus.TERMINATED;
  }
  if (person.lifecycle === 'future-joiner' || person.lifecycle === 'joiner-batch') {
    return UserStatus.PENDING;
  }
  return UserStatus.ACTIVE;
}

function primarySource(person: DemoPerson): string {
  return UNLINKED.includes(person.lifecycle) ? SECONDARY_HR : PRIMARY_HR;
}

function toDto(ctx: SeedContext, person: DemoPerson): StandardUserDto {
  const manager = managerOf(ctx, person);
  const { department: dept, office } = person;
  return StandardUserSchema.parse({
    sourceSystem: primarySource(person),
    sourceUserId: person.employeeId,
    tenantId: ctx.tenantId,
    firstName: person.firstName,
    lastName: person.lastName,
    displayName: `${person.firstName} ${person.lastName}`,
    email: person.email,
    userPrincipalName: person.email,
    samAccountName: person.email.split('@')[0].replace(/\./g, '').slice(0, 20),
    jobTitle: person.jobTitle,
    departmentCode: dept.code,
    departmentName: dept.name,
    division: dept.division,
    costCenter: `CC-${dept.code}`,
    employeeId: person.employeeId,
    employmentType: person.employmentType,
    managerEmail: manager?.email,
    managerId: manager?.employeeId,
    startDate: person.startDate,
    endDate: person.endDate,
    location: office.code,
    officeName: office.office,
    officeLocation: office.office,
    city: office.city,
    stateProvince: office.state,
    countryCode: office.country,
    postalCode: office.postal,
    timezone: office.tz,
    status: statusOf(person),
    priority:
      person.role === 'ceo' || person.role === 'head' ? UserPriority.VIP : UserPriority.STANDARD,
  }) as StandardUserDto;
}

/**
 * The record as HR ingest stores it: the row's fields as strings, the status a UserStatus (the
 * ingest validates the row with StandardUserSchema; an HR system's own status word would be in
 * customAttributes.hrStatus).
 */
export function hrRecord(ctx: SeedContext, person: DemoPerson): Record<string, unknown> {
  const gone = person.lifecycle === 'terminated' || person.lifecycle === 'soft-deleted';
  return {
    employeeId: person.employeeId,
    firstName: person.firstName,
    lastName: person.lastName,
    email: person.email,
    jobTitle: person.jobTitle,
    departmentCode: person.department.code,
    departmentName: person.department.name,
    employmentType: person.employmentType,
    managerEmail: managerOf(ctx, person)?.email,
    location: person.office.code,
    startDate: isoDay(person.startDate),
    ...(person.endDate ? { endDate: isoDay(person.endDate) } : {}),
    status: gone ? UserStatus.TERMINATED : UserStatus.ACTIVE,
  };
}

function sources(ctx: SeedContext, rng: SeededRandom, person: DemoPerson): LinkedAccount[] {
  const lastSync = daysFrom(ctx.anchor, 0, -rng.int(2, 20));
  const unlinked = UNLINKED.includes(person.lifecycle);
  const out: LinkedAccount[] = [
    {
      sourceName: primarySource(person),
      externalId: person.employeeId,
      lastSync,
      rawData: hrRecord(ctx, person),
      contractType: 'primary',
      sourceRole: unlinked ? 'secondary-hr' : 'primary-hr',
    },
  ];
  if (person.secondaryHr) {
    out.push({
      sourceName: SECONDARY_HR,
      externalId: `JA-${person.employeeId}`,
      lastSync,
      rawData: {
        ...hrRecord(ctx, person),
        employeeId: `JA-${person.employeeId}`,
        jobTitle: 'Guest Trainer',
        departmentName: 'Kestrel Academy',
        employmentType: 'PART_TIME',
      },
      contractType: 'secondary',
      sourceRole: 'secondary-hr',
    });
  }
  return out;
}

function entraSource(ctx: SeedContext, person: DemoPerson, lastSync: Date): LinkedAccount {
  const objectId = entraObjectId(ctx, person);
  return {
    sourceName: 'entra',
    externalId: objectId,
    lastSync,
    rawData: { objectId, email: person.email, userPrincipalName: person.email },
    sourceRole: 'target',
  };
}

function conflictDetails(ctx: SeedContext, person: DemoPerson, variant: number) {
  const record = {
    ...hrRecord(ctx, person),
    employeeId: `IB-${3001 + variant}`,
    ...(variant === 0 ? { lastName: `${person.lastName}-García` } : {}),
    ...(variant === 1 ? { departmentName: 'Support', jobTitle: 'Support Engineer' } : {}),
    ...(variant === 2 ? { firstName: person.firstName.slice(0, 1) + '.' } : {}),
  };
  const snapshot = (r: Record<string, unknown>) => ({
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    departmentName: r.departmentName,
    jobTitle: r.jobTitle,
  });
  return {
    matchedBy: 'email',
    matchedValue: person.email,
    confidence: 0,
    existingSnapshot: { sourceName: PRIMARY_HR, ...snapshot(hrRecord(ctx, person)) },
    incomingSnapshot: {
      sourceName: SECONDARY_HR,
      externalId: record.employeeId,
      ...snapshot(record),
    },
    incomingSource: {
      sourceName: SECONDARY_HR,
      externalId: String(record.employeeId),
      lastSync: daysFrom(ctx.anchor, 0, -3),
      rawData: record,
      contractType: 'secondary',
      sourceRole: 'secondary-hr',
    },
  };
}

function metadata(ctx: SeedContext, person: DemoPerson, conflictIndex: number) {
  const status = UNLINKED.includes(person.lifecycle) ? person.lifecycle : 'correlated';
  return {
    demoSeed: true,
    primaryHrSource: primarySource(person),
    primaryContractExternalId: person.employeeId,
    correlationStatus: status,
    ...(person.candidates
      ? { ambiguousCandidates: person.candidates.map((i) => String(identityId(ctx, i))) }
      : {}),
    ...(person.conflict
      ? {
          correlationConflict: true,
          requiresReview: true,
          conflictDetails: conflictDetails(ctx, person, conflictIndex),
        }
      : {}),
  };
}

function baselineOf(person: DemoPerson, profile: Record<string, unknown>, recordedAt: Date) {
  const before = person.previous
    ? {
        ...profile,
        departmentCode: person.previous.department.code,
        departmentName: person.previous.department.name,
        division: person.previous.department.division,
        costCenter: `CC-${person.previous.department.code}`,
        jobTitle: person.previous.jobTitle,
      }
    : profile;
  const moved = person.lifecycle === 'mover-done';
  return {
    attributes: toAccessBaseline(moved ? profile : before),
    recordedAt: moved ? daysFrom(recordedAt, 30) : recordedAt,
    recordedBy: moved ? 'mover' : 'provisioning',
  };
}

export function buildIdentities(ctx: SeedContext): {
  docs: Record<string, unknown>[];
  plan: ProvisioningPlan;
} {
  const rng = sectionRandom('identities');
  const plan = planProvisioning(ctx.people, sectionRandom('provisioning'));
  let conflicts = 0;
  const docs = ctx.people.map((person) => {
    const profile = dtoToProfile(toDto(ctx, person));
    const provisioning = buildProvisioning(ctx, rng, person, plan);
    const linked = sources(ctx, rng, person);
    const entra = provisioning.find((p) => p.targetSystem === 'entra');
    if (entra) {
      linked.push(entraSource(ctx, person, entra.lastSync ?? ctx.anchor));
      profile.customAttributes = { entraObjectId: entraObjectId(ctx, person) };
    }
    const firstSync = provisioning.find((p) => p.provisionedAt)?.provisionedAt;
    const createdAt =
      person.startDate > ctx.anchor
        ? daysFrom(ctx.anchor, -rng.int(3, 12))
        : daysFrom(person.startDate, -rng.int(7, 21));
    const deleted = person.lifecycle === 'soft-deleted' && person.endDate;
    return {
      _id: identityId(ctx, person.index),
      tenantId: ctx.tenantId,
      profile,
      sources: linked,
      controls: { isLoginDisabled: statusOf(person) === UserStatus.TERMINATED },
      provisioning,
      ...(firstSync ? { accessBaseline: baselineOf(person, profile, firstSync) } : {}),
      ...(deleted ? { deletedAt: daysFrom(person.endDate!, 1, 2), deletedBy: 'offboarding' } : {}),
      metadata: metadata(ctx, person, person.conflict ? conflicts++ : 0),
      createdAt,
      updatedAt: daysFrom(ctx.anchor, 0, -rng.int(1, 48)),
    };
  });
  return { docs, plan };
}
