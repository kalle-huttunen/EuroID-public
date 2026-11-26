import { describe, it, expect } from 'vitest';
import { matchNavItem, visibleNavSections, visibleNavItems, type NavAccess } from '../navigation';

const paths = (items: Array<{ path: string }>) => items.map((i) => i.path);
const sectionPaths = (access: NavAccess, devTools: boolean) =>
  paths(visibleNavSections(access, devTools).flatMap((s) => s.items));

const viewer: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false };
const tenantSuperAdmin: NavAccess = { isSuperAdmin: true, isPlatformAdmin: false };
/** A platform admin keeps its own tenant role, here a viewer. */
const platformAdminViewer: NavAccess = { isSuperAdmin: false, isPlatformAdmin: true };

describe('navigation gating', () => {
  it('hides developer, admin and platform pages from users who are neither', () => {
    const visible = sectionPaths(viewer, true);
    expect(visible).toContain('/dashboard');
    expect(visible).not.toContain('/dev/workflows');
    expect(visible).not.toContain('/dev/transactions');
    expect(visible).not.toContain('/admin/scim');
    expect(visible).not.toContain('/admin/tenants');
  });

  it('shows developer and admin pages to a super-admin in a non-production build', () => {
    const visible = sectionPaths(tenantSuperAdmin, true);
    expect(visible).toContain('/dev/workflows');
    expect(visible).toContain('/dev/transactions');
    expect(visible).toContain('/admin/scim');
  });

  // /tenants answers 403 to a tenant super-admin (every tenant has one): only the deployment's
  // platform admins may manage tenants.
  it('hides tenant management from a tenant super-admin who is not a platform admin', () => {
    expect(sectionPaths(tenantSuperAdmin, true)).not.toContain('/admin/tenants');
    expect(sectionPaths(tenantSuperAdmin, false)).not.toContain('/admin/tenants');
  });

  it('shows tenant management to a platform admin, whatever its tenant role', () => {
    const visible = sectionPaths(platformAdminViewer, false);
    expect(visible).toContain('/admin/tenants');
    expect(visible).not.toContain('/admin/scim');
    expect(sectionPaths({ isSuperAdmin: true, isPlatformAdmin: true }, false)).toContain(
      '/admin/tenants',
    );
  });

  it('drops developer pages in a production build, even for a super-admin', () => {
    const visible = sectionPaths(tenantSuperAdmin, false);
    expect(visible).not.toContain('/dev/workflows');
    expect(visible).not.toContain('/dev/transactions');
    expect(visible).toContain('/admin/scim');
  });

  // GET /dead-letter needs operator (or a role above it): a viewer would only get 403s.
  it('shows the dead-letter queue to operators and above, never to a viewer', () => {
    expect(sectionPaths(viewer, true)).not.toContain('/dead-letter');
    expect(paths(visibleNavItems(viewer, true))).not.toContain('/dead-letter');
    expect(sectionPaths(platformAdminViewer, false)).not.toContain('/dead-letter');
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    expect(sectionPaths(operator, false)).toContain('/dead-letter');
    expect(paths(visibleNavItems(operator, false))).toContain('/dead-letter');
    expect(sectionPaths({ ...tenantSuperAdmin, isOperator: true }, false)).toContain(
      '/dead-letter',
    );
    // The rest of its section stays visible to a viewer.
    expect(sectionPaths(viewer, true)).toContain('/reconciliation/uncorrelated');
  });

  // Every bulk provisioning route needs operator (bulk-provisioning.controller.ts); the route
  // in App.tsx is gated the same way.
  it('shows bulk operations to operators and above, never to a viewer', () => {
    expect(sectionPaths(viewer, false)).not.toContain('/bulk-operations');
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    expect(sectionPaths(operator, false)).toContain('/bulk-operations');
  });

  // The DSAR export, the consent changes and the consent report need operator (erasure
  // super-admin, gated on the page): a viewer would only get 403s.
  it('shows GDPR requests to operators and above in Governance, never to a viewer', () => {
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    const governance = (access: NavAccess) =>
      paths(visibleNavSections(access, false).find((s) => s.key === 'governance')?.items ?? []);
    expect(governance(operator)).toContain('/compliance/gdpr');
    expect(paths(visibleNavItems(operator, false))).toContain('/compliance/gdpr');
    expect(governance({ ...tenantSuperAdmin, isOperator: true })).toContain('/compliance/gdpr');
    expect(sectionPaths(viewer, true)).not.toContain('/compliance/gdpr');
    expect(paths(visibleNavItems(viewer, true))).not.toContain('/compliance/gdpr');
    expect(sectionPaths(platformAdminViewer, false)).not.toContain('/compliance/gdpr');
    // The rest of Governance stays visible to a viewer.
    expect(governance(viewer)).toContain('/audit');
    expect(matchNavItem('/compliance/gdpr')?.label).toBe('GDPR requests');
  });

  // /compliance-reports (generate, list, download) needs policy-admin or super-admin, like the
  // page's route: an operator or a viewer would land on Access Denied.
  it('shows compliance reports to policy-admins and super-admins only', () => {
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    const policyAdmin: NavAccess = { ...operator, isPolicyAdmin: true };
    const superAdmin: NavAccess = { ...tenantSuperAdmin, isOperator: true, isPolicyAdmin: true };
    expect(sectionPaths(policyAdmin, false)).toContain('/compliance/reports');
    expect(paths(visibleNavItems(policyAdmin, false))).toContain('/compliance/reports');
    expect(sectionPaths(superAdmin, false)).toContain('/compliance/reports');
    expect(sectionPaths(operator, true)).not.toContain('/compliance/reports');
    expect(paths(visibleNavItems(operator, true))).not.toContain('/compliance/reports');
    expect(sectionPaths(viewer, true)).not.toContain('/compliance/reports');
    expect(sectionPaths(platformAdminViewer, true)).not.toContain('/compliance/reports');
    expect(matchNavItem('/compliance/reports')?.label).toBe('Compliance reports');
  });

  // GET /sod-policies needs only viewer: every role reads the list (changes need policy-admin,
  // gated on the page). It sits next to the role-based rules whose access it checks.
  it('shows segregation of duties to every role, right after role-based rules', () => {
    const provisioning = (access: NavAccess) =>
      paths(visibleNavSections(access, false).find((s) => s.key === 'provisioning')!.items);
    expect(provisioning(viewer)).toEqual([
      '/blueprints',
      '/role-rules',
      '/sod-policies',
      '/connectors',
    ]);
    expect(provisioning(tenantSuperAdmin)).toContain('/sod-policies');
    expect(paths(visibleNavItems(viewer, false))).toContain('/sod-policies');
    expect(matchNavItem('/sod-policies')?.label).toBe('Segregation of duties');
  });

  // GET /nhi and GET /nhi/:agentId need viewer, the lowest tenant role: every role reads the
  // agents (create, delegate, revoke, kill switch and credentials need super-admin, gated on the
  // page). The entry sits in Identities, last.
  it('shows non-human identities to every role, last in Identities', () => {
    const identities = (access: NavAccess) =>
      paths(visibleNavSections(access, false).find((s) => s.key === 'identities')!.items);
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    for (const access of [viewer, operator, tenantSuperAdmin, platformAdminViewer]) {
      expect(identities(access).at(-1)).toBe('/nhi');
      expect(paths(visibleNavItems(access, false))).toContain('/nhi');
    }
    expect(matchNavItem('/nhi')?.label).toBe('Non-human identities');
    expect(matchNavItem('/nhi')?.section).toBe('Identities');
  });

  // Every GET of /access-explorer needs viewer, the lowest tenant role: every role reads the
  // access graph (the resync needs super-admin, gated on the page). The entry sits in Governance,
  // right after Access reviews.
  it('shows the access explorer to every role, after access reviews in Governance', () => {
    const governance = (access: NavAccess) =>
      paths(visibleNavSections(access, false).find((s) => s.key === 'governance')!.items);
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    for (const access of [viewer, operator, tenantSuperAdmin, platformAdminViewer]) {
      const items = governance(access);
      expect(items[items.indexOf('/intelligence/reviews') + 1]).toBe('/access-explorer');
      expect(paths(visibleNavItems(access, false))).toContain('/access-explorer');
    }
    expect(matchNavItem('/access-explorer')?.label).toBe('Access explorer');
    expect(matchNavItem('/access-explorer')?.section).toBe('Governance');
  });

  // GET /intelligence/peer-groups and GET /intelligence/peer-groups/:groupKey/outliers need
  // policy-admin, like the page's route: an operator or a viewer would land on Access Denied.
  it('shows peer groups to policy-admins and super-admins, after the risk dashboard', () => {
    const intelligence = (access: NavAccess) =>
      paths(visibleNavSections(access, false).find((s) => s.key === 'intelligence')!.items);
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    const policyAdmin: NavAccess = { ...operator, isPolicyAdmin: true };
    const superAdmin: NavAccess = { ...policyAdmin, isSuperAdmin: true };
    for (const access of [policyAdmin, superAdmin]) {
      expect(intelligence(access).slice(0, 2)).toEqual([
        '/intelligence/risk',
        '/intelligence/peer-groups',
      ]);
      expect(paths(visibleNavItems(access, false))).toContain('/intelligence/peer-groups');
    }
    for (const access of [viewer, operator, platformAdminViewer]) {
      expect(sectionPaths(access, true)).not.toContain('/intelligence/peer-groups');
      expect(paths(visibleNavItems(access, true))).not.toContain('/intelligence/peer-groups');
      // The rest of Intelligence stays visible.
      expect(intelligence(access)).toContain('/intelligence/risk');
    }
    expect(matchNavItem('/intelligence/peer-groups')?.label).toBe('Peer groups');
    expect(matchNavItem('/intelligence/peer-groups')?.section).toBe('Intelligence');
  });

  // Every /event-subscriptions route needs super-admin. Webhooks run in production, so they sit
  // in Admin, not in the dev-only Developers section.
  it('shows webhooks to a super-admin, in production builds too, and to nobody else', () => {
    expect(sectionPaths(tenantSuperAdmin, false)).toContain('/admin/webhooks');
    expect(paths(visibleNavItems(tenantSuperAdmin, false))).toContain('/admin/webhooks');
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    expect(sectionPaths(operator, true)).not.toContain('/admin/webhooks');
    expect(paths(visibleNavItems(operator, true))).not.toContain('/admin/webhooks');
    expect(sectionPaths(viewer, true)).not.toContain('/admin/webhooks');
    expect(sectionPaths(platformAdminViewer, true)).not.toContain('/admin/webhooks');
  });

  // GET /auth/users, POST /auth/invites, POST /auth/revoke/:userId and PATCH /auth/users/:id all
  // need super-admin. A platform admin manages tenants, not another tenant's admins.
  it('shows admin users to a super-admin, first in Admin, and to nobody else', () => {
    const admin = (access: NavAccess) =>
      paths(visibleNavSections(access, false).find((s) => s.key === 'admin')?.items ?? []);
    expect(admin(tenantSuperAdmin)[0]).toBe('/admin/users');
    expect(paths(visibleNavItems(tenantSuperAdmin, false))).toContain('/admin/users');
    expect(matchNavItem('/admin/users')?.label).toBe('Admin users');
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    expect(sectionPaths(operator, true)).not.toContain('/admin/users');
    expect(paths(visibleNavItems(operator, true))).not.toContain('/admin/users');
    expect(sectionPaths(viewer, true)).not.toContain('/admin/users');
    expect(sectionPaths(platformAdminViewer, true)).not.toContain('/admin/users');
  });

  // GET /audit/verify-integrity, the Merkle routes and the anchor route all need super-admin; the
  // audit log next to it needs only viewer.
  it('shows audit integrity to a super-admin only, right after the audit log', () => {
    const governance = (access: NavAccess) =>
      paths(visibleNavSections(access, false).find((s) => s.key === 'governance')?.items ?? []);
    expect(governance(tenantSuperAdmin).slice(0, 2)).toEqual(['/audit', '/audit/integrity']);
    expect(paths(visibleNavItems(tenantSuperAdmin, false))).toContain('/audit/integrity');
    expect(matchNavItem('/audit/integrity')?.label).toBe('Audit integrity');
    expect(matchNavItem('/audit')?.label).toBe('Audit & compliance');
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    const policyAdmin: NavAccess = { ...operator, isPolicyAdmin: true };
    for (const access of [viewer, operator, policyAdmin, platformAdminViewer]) {
      expect(sectionPaths(access, true)).not.toContain('/audit/integrity');
      expect(paths(visibleNavItems(access, true))).not.toContain('/audit/integrity');
      expect(sectionPaths(access, true)).toContain('/audit');
    }
  });

  // Governance holds three entries gated by three different roles: each needs its own flag, and
  // the filter needs all of them at once (requiresSuperAdmin, requiresPolicyAdmin, requiresOperator).
  it('gives each role exactly its Governance entries', () => {
    const governance = (access: NavAccess) =>
      paths(visibleNavSections(access, false).find((s) => s.key === 'governance')?.items ?? []);
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    const policyAdmin: NavAccess = { ...operator, isPolicyAdmin: true };
    const superAdmin: NavAccess = { ...policyAdmin, isSuperAdmin: true };
    const gated = [
      '/audit/integrity',
      '/compliance/reports',
      '/compliance/gdpr',
      '/credentials',
      '/leavers',
    ];
    const shown = (access: NavAccess) => gated.filter((p) => governance(access).includes(p));

    expect(shown(viewer)).toEqual([]);
    expect(shown(operator)).toEqual(['/compliance/gdpr', '/credentials']);
    expect(shown(policyAdmin)).toEqual([
      '/compliance/reports',
      '/compliance/gdpr',
      '/credentials',
      '/leavers',
    ]);
    expect(shown(superAdmin)).toEqual(gated);
    expect(governance(superAdmin)).toEqual([
      '/audit',
      '/audit/integrity',
      '/compliance/reports',
      '/compliance/gdpr',
      '/intelligence/reviews',
      '/access-explorer',
      '/credentials',
      '/leavers',
    ]);
  });

  it('command palette pages follow the same gating and keep the extra pages', () => {
    const viewerPages = paths(visibleNavItems(viewer, true));
    expect(viewerPages).not.toContain('/dev/workflows');
    expect(viewerPages).not.toContain('/admin/scim');
    expect(viewerPages).toContain('/settings/security');
    expect(paths(visibleNavItems(tenantSuperAdmin, true))).toContain('/dev/workflows');
    expect(paths(visibleNavItems(tenantSuperAdmin, true))).not.toContain('/admin/tenants');
    expect(paths(visibleNavItems(platformAdminViewer, true))).toContain('/admin/tenants');
  });

  // The due list, the unchecked list and a person's credentials need operator (the compliance
  // summary and the policies policy-admin, gated on the page): a viewer would only get 403s.
  it('shows credential lifecycle to operators and above, never to a viewer', () => {
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    expect(sectionPaths(operator, false)).toContain('/credentials');
    expect(paths(visibleNavItems(operator, false))).toContain('/credentials');
    expect(sectionPaths({ ...operator, isPolicyAdmin: true }, false)).toContain('/credentials');
    expect(sectionPaths(viewer, true)).not.toContain('/credentials');
    expect(paths(visibleNavItems(viewer, true))).not.toContain('/credentials');
    expect(sectionPaths(platformAdminViewer, true)).not.toContain('/credentials');
    expect(matchNavItem('/credentials')?.label).toBe('Credential lifecycle');
  });

  // Every /leavers, /joiners and /movers route needs policy-admin, like the page's route: an
  // operator or a viewer would land on Access Denied (FOLLOWUPS 2026-11-24).
  it('shows joiners, movers and leavers to policy-admins and super-admins only', () => {
    const operator: NavAccess = { isSuperAdmin: false, isPlatformAdmin: false, isOperator: true };
    const policyAdmin: NavAccess = { ...operator, isPolicyAdmin: true };
    expect(sectionPaths(policyAdmin, false)).toContain('/leavers');
    expect(paths(visibleNavItems(policyAdmin, false))).toContain('/leavers');
    expect(sectionPaths({ ...policyAdmin, isSuperAdmin: true }, false)).toContain('/leavers');
    for (const access of [viewer, operator, platformAdminViewer]) {
      expect(sectionPaths(access, true)).not.toContain('/leavers');
      expect(paths(visibleNavItems(access, true))).not.toContain('/leavers');
    }
  });

  // One page holds the HR-driven joiner, mover and leaver batches and limits (route /leavers).
  it('names the HR lifecycle page after joiners, movers and leavers', () => {
    // A super-admin holds policy-admin too (usePermission's role hierarchy).
    const item = visibleNavSections({ ...tenantSuperAdmin, isPolicyAdmin: true }, false)
      .flatMap((s) => s.items)
      .find((i) => i.path === '/leavers');
    expect(item?.label).toBe('Joiners, movers and leavers');
  });
});
