/**
 * The entitlement catalog of the demo company: department groups, requestable groups and
 * licenses, directory roles, and the AD, Okta and GitHub groups the policies assign.
 */
import { createHash } from 'crypto';
import { daysFrom, seededObjectId, seededUuid } from './random';
import type { SeedContext } from './context';
import type { DemoPerson } from './people';

type CatalogSystem = 'entra-id' | 'ad' | 'okta' | 'github';
type CatalogType = 'Group' | 'License' | 'DirectoryRole';

interface CatalogDef {
  key: string;
  system: CatalogSystem;
  type: CatalogType;
  name: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Assigned by a policy (STRICT) rather than discovered in the target. */
  policy?: boolean;
  /** Department whose head owns and certifies it. */
  ownerDept: string;
  request?: { category: string; text: string; maxDays?: number };
  adminTier?: 'TIER_0' | 'TIER_1' | 'TIER_2';
}

const DEPARTMENT_GROUPS =
  'All Staff,Engineering,Sales,Marketing,Finance,Human Resources,Legal,Product,Support,Operations';

/**
 * key | system | type | name | risk | owning department | P (assigned by a policy) or the
 * request portal category | max request days | admin tier | portal description
 */
const TABLE = `
grp-leadership|entra-id|Group|Leadership Team|HIGH|Operations|P|||
grp-vpn|entra-id|Group|VPN Users|MEDIUM|Operations|Network|180||Remote access to the office networks.
grp-ap-clerks|entra-id|Group|Finance AP Clerks|HIGH|Finance|Finance|||Create vendors and enter supplier invoices.
grp-ap-approvers|entra-id|Group|Finance AP Approvers|CRITICAL|Finance|Finance|||Approve supplier payments.
grp-payroll|entra-id|Group|Payroll Administrators|CRITICAL|Human Resources|HR|||Run and correct payroll.
grp-hr-records|entra-id|Group|HR Records Editors|HIGH|Human Resources|HR|||Edit employee records in the HR system.
grp-cab|entra-id|Group|Change Advisory Board|MEDIUM|Engineering|Engineering|||Approve production changes.
grp-prod-db|entra-id|Group|Prod Database Readers|HIGH|Engineering|Engineering|30||Read-only access to production databases.
lic-e3|entra-id|License|Microsoft 365 E3|LOW|Operations|P|||
lic-e5|entra-id|License|Microsoft 365 E5|MEDIUM|Operations|Licenses|365||Advanced security and compliance features.
lic-powerbi|entra-id|License|Power BI Pro|LOW|Finance|Analytics|||Build and share reports.
lic-visio|entra-id|License|Visio Plan 2|LOW|Operations|Licenses|||Diagrams and process maps.
role-global-reader|entra-id|DirectoryRole|Global Reader|MEDIUM|Engineering|||TIER_2|
role-helpdesk|entra-id|DirectoryRole|Helpdesk Administrator|HIGH|Support|||TIER_2|
role-user-admin|entra-id|DirectoryRole|User Administrator|HIGH|Engineering|||TIER_1|
ad-finance-share|ad|Group|GG-Finance-Share|HIGH|Finance|P|||
ad-eng-build|ad|Group|GG-Engineering-Build|MEDIUM|Engineering|P|||
ad-vpn|ad|Group|GG-VPN|MEDIUM|Operations||||
okta-salesforce|okta|Group|Salesforce|MEDIUM|Sales|P|||
okta-hubspot|okta|Group|HubSpot|LOW|Marketing|P|||
okta-zendesk|okta|Group|Zendesk|LOW|Support|P|||
gh-engineering|github|Group|kestrel/engineering|MEDIUM|Engineering|P|||
gh-platform-admins|github|Group|kestrel/platform-admins|CRITICAL|Engineering|Engineering|14||Admin rights on the platform repositories.
`;

function parseRow(row: string): CatalogDef {
  const [key, system, type, name, risk, ownerDept, use, maxDays, tier, text] = row.split('|');
  return {
    key,
    system: system as CatalogSystem,
    type: type as CatalogType,
    name,
    risk: risk as CatalogDef['risk'],
    policy: use === 'P',
    ownerDept,
    ...(use && use !== 'P'
      ? { request: { category: use, text, ...(maxDays ? { maxDays: Number(maxDays) } : {}) } }
      : {}),
    ...(tier ? { adminTier: tier as CatalogDef['adminTier'] } : {}),
  };
}

const DEFS: CatalogDef[] = [
  ...DEPARTMENT_GROUPS.split(',').map(
    (name): CatalogDef => ({
      key: `grp-${name}`,
      system: 'entra-id',
      type: 'Group',
      name,
      risk: name === 'Finance' || name === 'Human Resources' ? 'HIGH' : 'LOW',
      policy: true,
      ownerDept: name === 'All Staff' ? 'Operations' : name,
    }),
  ),
  ...TABLE.trim().split('\n').map(parseRow),
];

export interface CatalogEntry {
  id: string;
  key: string;
  system: CatalogSystem;
  type: CatalogType;
  name: string;
  nativeId: string;
  riskLevel: string;
  owner?: string;
}

function nativeIdOf(ctx: SeedContext, def: CatalogDef): string {
  if (def.system === 'entra-id') return seededUuid(ctx.tenantId, `catalog|${def.key}`);
  if (def.system === 'ad') return `CN=${def.name},OU=Demo Groups,DC=corp,DC=demo,DC=example,DC=com`;
  if (def.system === 'okta') {
    return `00g${createHash('sha256').update(`${ctx.tenantId}|${def.key}`).digest('hex').slice(0, 17)}`;
  }
  return `team:kestrel-${def.name.split('/')[1]}`;
}

function headOf(ctx: SeedContext, deptName: string): DemoPerson | undefined {
  return ctx.people.find((p) => p.role === 'head' && p.department.name === deptName);
}

export function catalogEntries(ctx: SeedContext): CatalogEntry[] {
  return DEFS.map((def, i) => ({
    id: String(seededObjectId(ctx.tenantId, 'catalog', i)),
    key: def.key,
    system: def.system,
    type: def.type,
    name: def.name,
    nativeId: nativeIdOf(ctx, def),
    riskLevel: def.risk,
    owner: headOf(ctx, def.ownerDept)?.email,
  }));
}

export function catalogEntry(ctx: SeedContext, key: string): CatalogEntry {
  const entry = catalogEntries(ctx).find((e) => e.key === key);
  if (!entry) throw new Error(`Demo catalog has no entry ${key}`);
  return entry;
}

export function buildCatalog(ctx: SeedContext): Record<string, unknown>[] {
  return catalogEntries(ctx).map((entry, i) => {
    const def = DEFS[i];
    return {
      _id: entry.id,
      tenantId: ctx.tenantId,
      system: def.system,
      nativeId: entry.nativeId,
      name: def.name,
      type: def.type,
      origin: def.policy ? 'POLICY' : 'EXTERNAL',
      governanceLevel: def.policy || def.adminTier ? 'STRICT' : 'OPEN',
      metadata: { demoSeed: true, discoveredAt: daysFrom(ctx.anchor, -90) },
      governanceTags: def.risk === 'CRITICAL' ? ['sox'] : [],
      owner: entry.owner,
      riskLevel: def.risk,
      ...(def.adminTier ? { adminTier: def.adminTier, requiresAdminAccount: true } : {}),
      requestable: !!def.request,
      approvalRequired: true,
      approvalChain: def.request ? [{ type: 'MANAGER' }, { type: 'OWNER' }] : [],
      ...(def.request
        ? {
            category: def.request.category,
            userDescription: def.request.text,
            ...(def.request.maxDays ? { maxDurationDays: def.request.maxDays } : {}),
          }
        : {}),
    };
  });
}
