/**
 * The people of the demo company: an org chart (CEO, department heads, team leads, members) with
 * names, offices, employment types, dates and a lifecycle for the few that are joining, leaving,
 * moving or waiting for correlation. Pure: the same count and day give the same people.
 */
import { EmploymentType } from '@shared/dtos/standard-user.dto';
import { DEMO_SEED_KEY, SeededRandom, daysFrom } from './random';
import {
  DEMO_EMAIL_DOMAIN,
  DEPARTMENT_POOLS,
  EXECUTIVE_POOL,
  MOBILE_NAME_POOLS,
  NAME_POOLS,
  OFFICE_POOLS,
  SUBSIDIARY_EMAIL_DOMAIN,
  asciiName,
  type DepartmentPool,
  type OfficePool,
} from './pools';

export type Lifecycle =
  | 'active'
  | 'future-joiner'
  | 'joiner-batch'
  | 'terminated'
  | 'soft-deleted'
  | 'leaver-batch'
  | 'mover-batch'
  | 'mover-done'
  | 'uncorrelated'
  | 'ambiguous';

export type OrgRole = 'ceo' | 'head' | 'lead' | 'member';

export interface DemoPerson {
  index: number;
  firstName: string;
  lastName: string;
  email: string;
  employeeId: string;
  department: DepartmentPool;
  jobTitle: string;
  role: OrgRole;
  managerIndex?: number;
  office: OfficePool;
  employmentType: EmploymentType;
  startDate: Date;
  endDate?: Date;
  lifecycle: Lifecycle;
  /** A second, concurrent contract in the JSON API HR source. */
  secondaryHr: boolean;
  /** A JSON API HR record with this person's email waits for a conflict review. */
  conflict: boolean;
  /** Department and title before the move (mover lifecycles). */
  previous?: { department: DepartmentPool; jobTitle: string };
  /** For ambiguous records: the people they could be. */
  candidates?: number[];
}

/** People with a lifecycle of their own, taken from the members of the org chart. */
const LIFECYCLE_QUOTA: Array<[Lifecycle | 'conflict', number]> = [
  ['future-joiner', 3],
  ['joiner-batch', 3],
  ['terminated', 3],
  ['leaver-batch', 3],
  ['mover-batch', 3],
  ['mover-done', 2],
  ['conflict', 3],
];

/** Subsidiary records the correlation could not link (2) or could not decide on (2). */
const UNLINKED = 4;
/** Offboarded people (soft-deleted), on top of the count the identity hub lists. */
export const SOFT_DELETED = 3;
/** The smallest count that leaves room for every lifecycle above. */
export const MIN_COUNT = 60;

function allocate(total: number, pools: DepartmentPool[]): number[] {
  const weight = pools.reduce((sum, p) => sum + p.weight, 0);
  const exact = pools.map((p) => (total * p.weight) / weight);
  const sizes = exact.map((x) => Math.max(3, Math.floor(x)));
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; sizes.reduce((s, x) => s + x, 0) < total; k++)
    sizes[order[k % order.length][1]]++;
  return sizes;
}

class PeopleBuilder {
  readonly people: DemoPerson[] = [];
  private readonly rng = new SeededRandom(`${DEMO_SEED_KEY}|people`);
  private readonly emails = new Set<string>();

  constructor(private readonly anchor: Date) {}

  add(
    department: DepartmentPool,
    role: OrgRole,
    jobTitle: string,
    managerIndex: number | undefined,
    yearsBack: [number, number],
  ): DemoPerson {
    const office = OFFICE_POOLS[this.rng.weighted(OFFICE_POOLS.map((o) => o.weight))];
    const names =
      NAME_POOLS[this.rng.chance(0.8) ? office.names : this.rng.pick(MOBILE_NAME_POOLS)];
    const index = this.people.length;
    const firstName = this.rng.pick(names.first);
    const lastName = this.rng.pick(names.last);
    const person: DemoPerson = {
      index,
      firstName,
      lastName,
      email: this.email(firstName, lastName, DEMO_EMAIL_DOMAIN),
      employeeId: `E${10001 + index}`,
      department,
      jobTitle,
      role,
      managerIndex,
      office,
      employmentType: EmploymentType.FULL_TIME,
      startDate: daysFrom(this.anchor, -this.rng.int(yearsBack[0] * 365, yearsBack[1] * 365)),
      lifecycle: 'active',
      secondaryHr: false,
      conflict: false,
    };
    this.people.push(person);
    return person;
  }

  email(first: string, last: string, domain: string): string {
    const base = `${asciiName(first)}.${asciiName(last)}`;
    let local = base;
    for (let n = 2; this.emails.has(`${local}@${domain}`); n++) local = `${base}${n}`;
    this.emails.add(`${local}@${domain}`);
    return `${local}@${domain}`;
  }

  get random(): SeededRandom {
    return this.rng;
  }
}

function buildOrgChart(b: PeopleBuilder, orgSize: number): void {
  const ceo = b.add(EXECUTIVE_POOL, 'ceo', EXECUTIVE_POOL.headTitle, undefined, [7, 9]);
  b.add(EXECUTIVE_POOL, 'member', 'Executive Assistant', ceo.index, [1, 5]);
  const sizes = allocate(orgSize - 2, DEPARTMENT_POOLS);
  DEPARTMENT_POOLS.forEach((dept, d) => {
    const head = b.add(dept, 'head', dept.headTitle, ceo.index, [3, 8]);
    const memberCount = sizes[d] - 1;
    const leadCount = memberCount >= 9 ? Math.round(memberCount / 8) : 0;
    const leads = Array.from({ length: leadCount }, () =>
      b.add(dept, 'lead', dept.leadTitle, head.index, [2, 6]),
    );
    for (let m = 0; m < memberCount - leadCount; m++) {
      const manager = leads.length ? leads[m % leads.length].index : head.index;
      b.add(dept, 'member', b.random.pick(dept.titles), manager, [0.1, 7]);
    }
  });
}

function setEmployment(b: PeopleBuilder, p: DemoPerson, anchor: Date): void {
  if (p.role !== 'member' || p.department === EXECUTIVE_POOL) return;
  const roll = b.random.next();
  if (roll < 0.07) {
    p.employmentType = EmploymentType.CONTRACTOR;
    p.jobTitle = `${p.jobTitle} (Contractor)`;
    p.startDate = daysFrom(anchor, -b.random.int(30, 540));
    p.endDate = daysFrom(anchor, b.random.int(20, 240));
  } else if (roll < 0.09) {
    p.employmentType = EmploymentType.CONSULTANT;
    p.endDate = daysFrom(anchor, b.random.int(30, 180));
  } else if (roll < 0.12) {
    p.employmentType = EmploymentType.INTERN;
    p.jobTitle = `${p.department.name} Intern`;
    p.startDate = daysFrom(anchor, -b.random.int(20, 150));
    p.endDate = daysFrom(anchor, b.random.int(30, 120));
  } else if (roll < 0.19) {
    p.employmentType = EmploymentType.PART_TIME;
  }
}

function applyLifecycle(b: PeopleBuilder, p: DemoPerson, kind: Lifecycle, anchor: Date): void {
  p.lifecycle = kind;
  if (kind === 'future-joiner' || kind === 'joiner-batch') {
    p.startDate = daysFrom(anchor, kind === 'future-joiner' ? b.random.int(4, 30) : -1);
    if (p.endDate) p.endDate = daysFrom(p.startDate, 180);
  }
  if (kind === 'terminated') p.endDate = daysFrom(anchor, -b.random.int(10, 60));
  if (kind === 'leaver-batch') p.endDate = daysFrom(anchor, -b.random.int(1, 3));
  if (kind === 'soft-deleted') p.endDate = daysFrom(anchor, -b.random.int(60, 150));
  if (kind === 'mover-batch' || kind === 'mover-done') {
    const others = DEPARTMENT_POOLS.filter((d) => d !== p.department);
    const from = b.random.pick(others);
    p.previous = { department: from, jobTitle: b.random.pick(from.titles) };
  }
  if (p.endDate && p.startDate >= p.endDate) p.startDate = daysFrom(p.endDate, -400);
}

function addUnlinked(b: PeopleBuilder, anchor: Date): void {
  const support = DEPARTMENT_POOLS.find((d) => d.name === 'Support') ?? DEPARTMENT_POOLS[0];
  const madrid = OFFICE_POOLS.find((o) => o.code === 'ES-MAD') ?? OFFICE_POOLS[0];
  const members = b.people.filter((p) => p.role === 'member' && p.lifecycle === 'active');
  for (let k = 0; k < UNLINKED; k++) {
    const ambiguous = k >= UNLINKED / 2;
    const twin = ambiguous ? b.random.pick(members) : undefined;
    const pool = NAME_POOLS[b.random.pick(['es', 'pt'])];
    const firstName = twin?.firstName ?? b.random.pick(pool.first);
    const lastName = twin?.lastName ?? b.random.pick(pool.last);
    b.people.push({
      index: b.people.length,
      firstName,
      lastName,
      email: b.email(firstName, lastName, SUBSIDIARY_EMAIL_DOMAIN),
      employeeId: `IB-${2001 + k}`,
      department: support,
      jobTitle: b.random.pick(support.titles),
      role: 'member',
      office: madrid,
      employmentType: EmploymentType.FULL_TIME,
      startDate: daysFrom(anchor, -b.random.int(60, 900)),
      lifecycle: ambiguous ? 'ambiguous' : 'uncorrelated',
      secondaryHr: false,
      conflict: false,
      candidates: twin ? [twin.index] : undefined,
    });
  }
}

/**
 * `count` people the identity hub lists, plus SOFT_DELETED offboarded ones. Index order: the org
 * chart (CEO first), the unlinked subsidiary records, then the offboarded people.
 */
export function planPeople(count: number, anchor: Date): DemoPerson[] {
  if (!Number.isInteger(count) || count < MIN_COUNT) {
    throw new Error(`The count must be a whole number of at least ${MIN_COUNT}.`);
  }
  const b = new PeopleBuilder(anchor);
  buildOrgChart(b, count - UNLINKED);
  for (const p of b.people) setEmployment(b, p, anchor);

  const members = b.random.shuffle(
    b.people.filter((p) => p.role === 'member' && p.department !== EXECUTIVE_POOL),
  );
  let next = 0;
  for (const [kind, quota] of LIFECYCLE_QUOTA) {
    for (let k = 0; k < quota; k++) {
      const p = members[next++];
      if (kind === 'conflict') p.conflict = true;
      else applyLifecycle(b, p, kind, anchor);
    }
  }
  for (const p of members.slice(next)) p.secondaryHr = b.random.chance(0.12);

  addUnlinked(b, anchor);
  for (let k = 0; k < SOFT_DELETED; k++) {
    const dept = b.random.pick(DEPARTMENT_POOLS);
    const head = b.people.find((p) => p.role === 'head' && p.department === dept);
    const p = b.add(dept, 'member', b.random.pick(dept.titles), head?.index, [2, 6]);
    applyLifecycle(b, p, 'soft-deleted', anchor);
  }
  return b.people;
}
