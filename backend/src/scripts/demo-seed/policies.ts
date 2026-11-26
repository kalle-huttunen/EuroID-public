/**
 * The access policies that assign the department groups, and the separation of duties policies
 * of the demo company.
 */
import { PolicyStatus, RiskLevel } from '@modules/policy/schemas/policy.schema';
import { daysFrom, seededObjectId } from './random';
import { DEMO_SEED_MARKER, workingPeople, type SeedContext } from './context';
import { catalogEntry } from './catalog';

const ENG = 'Engineering';
const FIN = 'Finance';

const POLICIES: Array<{
  name: string;
  description: string;
  field: string;
  values: string[];
  actions: Array<[string, string, Record<string, string>]>;
  risk: RiskLevel;
  status?: PolicyStatus;
}> = [
  {
    name: 'All employees: baseline access',
    description: 'Every employee gets the staff group and an Office licence.',
    field: 'employmentType',
    values: ['FULL_TIME', 'PART_TIME', 'INTERN'],
    actions: [
      ['assign_group', 'entra-id', { groupName: 'All Staff' }],
      ['assign_license', 'entra-id', { licenseSku: 'Microsoft 365 E3' }],
    ],
    risk: RiskLevel.LOW,
  },
  {
    name: 'Engineering: developer tooling',
    description: 'Engineering group, build share and the GitHub team.',
    field: 'departmentName',
    values: [ENG],
    actions: [
      ['assign_group', 'entra-id', { groupName: ENG }],
      ['assign_group', 'ad', { groupName: 'GG-Engineering-Build' }],
      ['assign_group', 'github', { groupName: 'kestrel/engineering' }],
    ],
    risk: RiskLevel.MEDIUM,
  },
  {
    name: 'Sales and Marketing: CRM access',
    description: 'CRM and marketing automation through Okta.',
    field: 'departmentName',
    values: ['Sales', 'Marketing'],
    actions: [
      ['assign_group', 'okta', { groupName: 'Salesforce' }],
      ['assign_group', 'okta', { groupName: 'HubSpot' }],
    ],
    risk: RiskLevel.MEDIUM,
  },
  {
    name: 'Finance: finance systems',
    description: 'Finance group and the finance file share.',
    field: 'departmentName',
    values: [FIN],
    actions: [
      ['assign_group', 'entra-id', { groupName: FIN }],
      ['assign_group', 'ad', { groupName: 'GG-Finance-Share' }],
    ],
    risk: RiskLevel.HIGH,
  },
  {
    name: 'Support: ticketing',
    description: 'Zendesk for the support team.',
    field: 'departmentName',
    values: ['Support'],
    actions: [
      ['assign_group', 'entra-id', { groupName: 'Support' }],
      ['assign_group', 'okta', { groupName: 'Zendesk' }],
    ],
    risk: RiskLevel.LOW,
  },
  {
    name: 'Contractors: time-bound VPN',
    description: 'Draft: VPN for contractors until their contract ends.',
    field: 'employmentType',
    values: ['CONTRACTOR'],
    actions: [['assign_group', 'entra-id', { groupName: 'VPN Users' }]],
    risk: RiskLevel.MEDIUM,
    status: PolicyStatus.DRAFT,
  },
];

export function buildPolicies(ctx: SeedContext): Record<string, unknown>[] {
  const working = workingPeople(ctx);
  return POLICIES.map((p, i) => {
    const matches = working.filter((person) =>
      p.values.includes(
        p.field === 'departmentName' ? person.department.name : person.employmentType,
      ),
    ).length;
    const active = p.status !== PolicyStatus.DRAFT;
    return {
      _id: seededObjectId(ctx.tenantId, 'policy', i),
      tenantId: ctx.tenantId,
      name: p.name,
      description: p.description,
      status: p.status ?? PolicyStatus.ACTIVE,
      priority: i === 0 ? 1 : 3,
      risk: p.risk,
      conditionGroups: [
        {
          id: `g${i}`,
          join: 'AND',
          conditions: [{ id: `c${i}`, field: p.field, operator: 'in', value: p.values }],
        },
      ],
      actions: p.actions.map(([type, target, params], k) => ({
        id: `a${i}-${k}`,
        type,
        target,
        params,
        label: `${type === 'assign_license' ? 'License' : 'Group'}: ${Object.values(params)[0]}`,
      })),
      tags: [],
      createdBy: DEMO_SEED_MARKER,
      ...(active ? { lastTriggered: daysFrom(ctx.anchor, -i - 1, 9) } : {}),
      affectedUsers: active ? matches : 0,
      totalExecutions: active ? matches + 12 * (i + 1) : 0,
    };
  });
}

const SOD: Array<
  [string, string, string, 'CRITICAL' | 'HIGH' | 'MEDIUM', 'BLOCK' | 'WARN', string]
> = [
  [
    'Create vendor vs. approve payment',
    'grp-ap-clerks',
    'grp-ap-approvers',
    'CRITICAL',
    'BLOCK',
    'Nobody both enters supplier invoices and approves their payment.',
  ],
  [
    'Payroll vs. HR records',
    'grp-payroll',
    'grp-hr-records',
    'HIGH',
    'WARN',
    'Running payroll and editing the records it pays from is a review finding.',
  ],
  [
    'Production admin vs. change approval',
    'gh-platform-admins',
    'grp-cab',
    'MEDIUM',
    'WARN',
    'Admins on the platform repositories should not approve their own changes.',
  ],
];

/** The policies name catalog entries by system, type and native id, as SoD checks match them. */
export function buildSodPolicies(ctx: SeedContext): Record<string, unknown>[] {
  return SOD.map(([name, a, b, severity, action, description], i) => ({
    _id: seededObjectId(ctx.tenantId, 'sod-policy', i),
    tenantId: ctx.tenantId,
    name,
    description,
    severity,
    action,
    isActive: true,
    conflictingEntitlements: [a, b].map((key) => {
      const entry = catalogEntry(ctx, key);
      return { system: entry.system, type: 'group', targetId: entry.nativeId };
    }),
  }));
}
