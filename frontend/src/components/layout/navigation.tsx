/**
 * Single source of navigation labels: the sidebar, the top bar breadcrumb and
 * the command palette all read from here, so page names cannot drift apart.
 */
import React from 'react';
import {
  TeamOutlined,
  DeploymentUnitOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  SyncOutlined,
  CloudUploadOutlined,
  AuditOutlined,
  BugOutlined,
  SwapOutlined,
  DashboardOutlined,
  SafetyCertificateOutlined,
  BulbOutlined,
  WarningOutlined,
  SolutionOutlined,
  BarChartOutlined,
  ApiOutlined,
  ExperimentOutlined,
  LinkOutlined,
  CheckSquareOutlined,
  FileTextOutlined,
  ClusterOutlined,
  SettingOutlined,
  LockOutlined,
  UserDeleteOutlined,
  InboxOutlined,
  SendOutlined,
  SplitCellsOutlined,
  IdcardOutlined,
  SecurityScanOutlined,
  VerifiedOutlined,
  KeyOutlined,
  RobotOutlined,
  ApartmentOutlined,
  DotChartOutlined,
} from '@ant-design/icons';
import { DEV_TOOLS_ENABLED } from '@config/dev-tools';

export interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  /** Only shown to operators and the roles above them (the page's backend gate). */
  requiresOperator?: boolean;
  /** Only shown to policy-admins and super-admins (the page's backend gate). */
  requiresPolicyAdmin?: boolean;
  /** Only shown to super-admins (the page's backend gate), in a section others see too. */
  requiresSuperAdmin?: boolean;
}

export interface NavSection {
  key: string;
  /** Group heading; omitted for the top entry. */
  title?: string;
  items: NavItem[];
  /** Only shown to super-admins. */
  superAdminOnly?: boolean;
  /** Only shown to platform admins (GET /auth/me `isPlatformAdmin`), whatever their tenant role. */
  platformAdminOnly?: boolean;
  /** Only present in non-production builds (see config/dev-tools.ts). */
  devToolsOnly?: boolean;
}

export const NAV_SECTIONS: NavSection[] = [
  {
    key: 'overview',
    items: [{ path: '/dashboard', label: 'Dashboard', icon: <DashboardOutlined /> }],
  },
  {
    key: 'identities',
    title: 'Identities',
    items: [
      { path: '/users', label: 'Identity hub', icon: <TeamOutlined /> },
      { path: '/access-requests', label: 'Access requests', icon: <ShoppingCartOutlined /> },
      {
        path: '/access-requests/approvals',
        label: 'Pending approvals',
        icon: <CheckSquareOutlined />,
      },
      // Every bulk provisioning route needs operator
      {
        path: '/bulk-operations',
        label: 'Bulk operations',
        icon: <CloudUploadOutlined />,
        requiresOperator: true,
      },
      // GET /nhi needs viewer: every role reads the agents (the changes need super-admin, gated
      // on the page).
      { path: '/nhi', label: 'Non-human identities', icon: <RobotOutlined /> },
    ],
  },
  {
    key: 'provisioning',
    title: 'Provisioning',
    items: [
      { path: '/blueprints', label: 'Design studio', icon: <DeploymentUnitOutlined /> },
      { path: '/role-rules', label: 'Role-based rules', icon: <ExperimentOutlined /> },
      {
        path: '/sod-policies',
        label: 'Segregation of duties',
        icon: <SplitCellsOutlined />,
      },
      { path: '/connectors', label: 'Connectors', icon: <ShopOutlined /> },
    ],
  },
  {
    key: 'reconciliation',
    title: 'Reconciliation',
    items: [
      { path: '/reconciliation', label: 'Drift dashboard', icon: <SyncOutlined /> },
      { path: '/reconciliation/uncorrelated', label: 'Uncorrelated queue', icon: <LinkOutlined /> },
      {
        path: '/dead-letter',
        label: 'Dead-letter queue',
        icon: <InboxOutlined />,
        requiresOperator: true,
      },
    ],
  },
  {
    key: 'governance',
    title: 'Governance',
    items: [
      { path: '/audit', label: 'Audit & compliance', icon: <AuditOutlined /> },
      // Every hash chain, Merkle and anchor route of the audit module needs super-admin.
      {
        path: '/audit/integrity',
        label: 'Audit integrity',
        icon: <VerifiedOutlined />,
        requiresSuperAdmin: true,
      },
      // Generate, list and download need policy-admin, like the page's route.
      {
        path: '/compliance/reports',
        label: 'Compliance reports',
        icon: <FileTextOutlined />,
        requiresPolicyAdmin: true,
      },
      // Every GDPR route the page acts on needs operator or above (erasure: super-admin, gated on
      // the page); a viewer could only list a person's consent records.
      {
        path: '/compliance/gdpr',
        label: 'GDPR requests',
        icon: <SecurityScanOutlined />,
        requiresOperator: true,
      },
      { path: '/intelligence/reviews', label: 'Access reviews', icon: <SolutionOutlined /> },
      // Every GET of /access-explorer needs viewer: every role reads the access graph (loading it
      // from MongoDB needs super-admin, gated on the page).
      { path: '/access-explorer', label: 'Access explorer', icon: <ApartmentOutlined /> },
      // The due list, the unchecked list and a person's credentials need operator; the page shows
      // the compliance summary and the policies (policy-admin routes) to policy-admins only.
      {
        path: '/credentials',
        label: 'Credential lifecycle',
        icon: <KeyOutlined />,
        requiresOperator: true,
      },
      // Every joiner, mover and leaver route needs policy-admin, like the page's route.
      {
        path: '/leavers',
        label: 'Joiners, movers and leavers',
        icon: <UserDeleteOutlined />,
        requiresPolicyAdmin: true,
      },
    ],
  },
  {
    key: 'intelligence',
    title: 'Intelligence',
    items: [
      { path: '/intelligence/risk', label: 'Risk dashboard', icon: <WarningOutlined /> },
      // Both peer group routes (the list and a group's outliers) need policy-admin, like the
      // page's route.
      {
        path: '/intelligence/peer-groups',
        label: 'Peer groups',
        icon: <DotChartOutlined />,
        requiresPolicyAdmin: true,
      },
      { path: '/intelligence/suggestions', label: 'Policy suggestions', icon: <BulbOutlined /> },
      { path: '/intelligence/analytics', label: 'Analytics', icon: <BarChartOutlined /> },
      {
        path: '/intelligence/privileged-access',
        label: 'Privileged access',
        icon: <SafetyCertificateOutlined />,
      },
    ],
  },
  {
    key: 'developers',
    title: 'Developers',
    superAdminOnly: true,
    devToolsOnly: true,
    items: [
      { path: '/dev/workflows', label: 'Workflow debugger', icon: <BugOutlined /> },
      { path: '/dev/transactions', label: 'Transaction viewer', icon: <SwapOutlined /> },
    ],
  },
  {
    key: 'admin',
    title: 'Admin',
    superAdminOnly: true,
    items: [
      // Who can sign in to this console. Every /auth admin route needs super-admin, like the
      // section's gate.
      { path: '/admin/users', label: 'Admin users', icon: <IdcardOutlined /> },
      { path: '/admin/scim', label: 'SCIM settings', icon: <ApiOutlined /> },
      // Outbound integrations sit with SCIM: tenant settings a super-admin manages in production
      // too (Developers is dev-builds only). The section's gate matches the API's super-admin.
      { path: '/admin/webhooks', label: 'Webhooks', icon: <SendOutlined /> },
      {
        path: '/admin/reconciliation-config',
        label: 'Reconciliation config',
        icon: <SettingOutlined />,
      },
    ],
  },
  {
    // Tenant management spans every tenant: the deployment's platform admins, not a tenant role.
    key: 'platform',
    title: 'Platform',
    platformAdminOnly: true,
    items: [{ path: '/admin/tenants', label: 'Tenants', icon: <ClusterOutlined /> }],
  },
];

/** What the signed-in user may see. */
export interface NavAccess {
  isSuperAdmin: boolean;
  isPlatformAdmin: boolean;
  /** Operator or a role above it; absent counts as no. */
  isOperator?: boolean;
  /** Policy-admin or super-admin; absent counts as no. */
  isPolicyAdmin?: boolean;
}

/** Pages reachable outside the sidebar (user menu, deep links). */
export const EXTRA_PAGES: NavItem[] = [
  { path: '/settings/security', label: 'Account security', icon: <LockOutlined /> },
];

const ALL_ITEMS: Array<NavItem & { section?: string }> = [
  ...NAV_SECTIONS.flatMap((s) => s.items.map((i) => ({ ...i, section: s.title }))),
  ...EXTRA_PAGES.map((i) => ({ ...i, section: 'Settings' })),
];

/** Longest registered path that prefixes `pathname`, or undefined. */
export function matchNavItem(pathname: string): (NavItem & { section?: string }) | undefined {
  return ALL_ITEMS.filter((i) => pathname === i.path || pathname.startsWith(`${i.path}/`)).sort(
    (a, b) => b.path.length - a.path.length,
  )[0];
}

/**
 * Sections this user may see: role-gated sections need super-admin, platform sections a platform
 * admin, dev tools a non-production build; operator items need operator or above, policy-admin
 * items policy-admin or super-admin, super-admin items a super-admin.
 */
export function visibleNavSections(
  access: NavAccess,
  devTools: boolean = DEV_TOOLS_ENABLED,
): NavSection[] {
  return NAV_SECTIONS.filter(
    (s) =>
      (!s.superAdminOnly || access.isSuperAdmin) &&
      (!s.platformAdminOnly || access.isPlatformAdmin) &&
      (!s.devToolsOnly || devTools),
  )
    .map((s) => ({
      ...s,
      items: s.items.filter(
        (i) =>
          (!i.requiresOperator || access.isOperator) &&
          (!i.requiresPolicyAdmin || access.isPolicyAdmin) &&
          (!i.requiresSuperAdmin || access.isSuperAdmin),
      ),
    }))
    .filter((s) => s.items.length > 0);
}

/** Pages the command palette offers: the visible sidebar entries plus EXTRA_PAGES. */
export function visibleNavItems(
  access: NavAccess,
  devTools: boolean = DEV_TOOLS_ENABLED,
): Array<NavItem & { section?: string }> {
  return [
    ...visibleNavSections(access, devTools).flatMap((s) =>
      s.items.map((i) => ({ ...i, section: s.title })),
    ),
    ...EXTRA_PAGES.map((i) => ({ ...i, section: 'Settings' })),
  ];
}
