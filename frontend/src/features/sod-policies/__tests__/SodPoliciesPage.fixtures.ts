/**
 * Shared fixtures of the SodPoliciesPage tests (SodPoliciesPage.test.tsx and
 * SodPoliciesPage.form.test.tsx). They follow GET /sod-policies (`SodPolicyResponse`: the
 * document's `_id` as `id`) and GET /entitlement-catalog (`{ entitlements, count }`). Each test file
 * mocks `@api/data` with the request mocks below and `usePermission` itself (vi.mock is hoisted
 * per file).
 */
import { createElement } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { ConfigProvider } from 'antd';
import { renderWithProviders } from '../../../test/test-utils';
import { SodPoliciesPage } from '../SodPoliciesPage';
import type { ISodPolicy } from '../../../interfaces';

export const mockGet = vi.fn();
export const mockPost = vi.fn();
export const mockPatch = vi.fn();
export const mockDelete = vi.fn();

export const AD_PAYMENTS_DN = 'CN=Payment Approvers,OU=Groups,DC=corp,DC=local';

/** Catalog entries per `system:type`, as GET /entitlement-catalog lists them. */
export const CATALOG: Record<string, Array<Record<string, string>>> = {
  'entra-id:Group': [
    { nativeId: 'grp-vendor-create', name: 'Vendor Create', type: 'Group' },
    { nativeId: 'grp-vendor-pay', name: 'Vendor Payments', type: 'Group' },
  ],
  'entra-id:DirectoryRole': [
    { nativeId: 'role-billing-admin', name: 'Billing Administrator', type: 'DirectoryRole' },
  ],
  'ad:Group': [{ nativeId: AD_PAYMENTS_DN, name: 'Payment Approvers', type: 'Group' }],
};

export const blockPolicy: ISodPolicy = {
  id: '64b7f0c2a1b2c3d4e5f60801',
  tenantId: 'tenant-a',
  name: 'Vendor create vs pay',
  description: 'Who creates vendors must not pay them',
  severity: 'CRITICAL',
  conflictingEntitlements: [
    { system: 'entra-id', type: 'group', targetId: 'grp-vendor-create' },
    { system: 'ad', type: 'group', targetId: AD_PAYMENTS_DN },
  ],
  isActive: true,
  action: 'BLOCK',
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
};

/** Deleted earlier: the backend keeps it with isActive false. Its second side is not cataloged. */
export const inactiveWarnPolicy: ISodPolicy = {
  id: '64b7f0c2a1b2c3d4e5f60802',
  tenantId: 'tenant-a',
  name: 'Payments vs GitHub release',
  severity: 'LOW',
  conflictingEntitlements: [
    { system: 'entra-id', type: 'group', targetId: 'grp-vendor-pay' },
    { system: 'github', type: 'team', targetId: 'release-managers' },
  ],
  isActive: false,
  action: 'WARN',
  createdAt: '2026-11-19T10:00:00.000Z',
  updatedAt: '2026-11-21T10:00:00.000Z',
};

export const LIST = /\/sod-policies$/;
export const ONE = (id: string) => new RegExp(`/sod-policies/${id}$`);

export function serve(policies: ISodPolicy[]) {
  mockGet.mockImplementation((url: string, config?: { params?: Record<string, string> }) => {
    if (LIST.test(url)) return Promise.resolve({ data: policies });
    if (url.endsWith('/entitlement-catalog')) {
      const key = `${config?.params?.system}:${config?.params?.type}`;
      const entitlements = (CATALOG[key] ?? []).map((e) => ({
        ...e,
        origin: 'EXTERNAL',
        governanceLevel: 'OPEN',
      }));
      return Promise.resolve({ data: { entitlements, count: entitlements.length } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  mockPost.mockImplementation((_url: string, body: Record<string, unknown>) =>
    Promise.resolve({ data: { ...body, id: '64b7f0c2a1b2c3d4e5f60899', tenantId: 'tenant-a' } }),
  );
  mockPatch.mockResolvedValue({ data: blockPolicy });
  mockDelete.mockResolvedValue({ data: { id: blockPolicy.id, isActive: false } });
}

export const listCalls = () =>
  mockGet.mock.calls.filter(([url]) => LIST.test(url as string)).length;

export function renderPage() {
  return renderWithProviders(
    // Without virtual scrolling, so jsdom renders every option of a dropdown.
    createElement(ConfigProvider, { virtual: false }, createElement(SodPoliciesPage)),
  );
}

/** Opens the select named `name` and clicks its option whose text starts with `optionText`. */
export async function choose(name: string, optionText: string) {
  const box = screen.getByRole('combobox', { name });
  fireEvent.mouseDown(box);
  const option = await waitFor(() => {
    const listId = box.getAttribute('aria-controls');
    const dropdown = listId
      ? document.getElementById(listId)?.closest('.ant-select-dropdown')
      : null;
    const found = Array.from(dropdown?.querySelectorAll('.ant-select-item-option') ?? []).find(
      (o) => o.textContent?.startsWith(optionText),
    );
    if (!found) throw new Error(`no option "${optionText}" in ${name}`);
    return found;
  });
  fireEvent.click(option);
}

/** The options a select offers, by their text. */
export async function optionsOf(name: string): Promise<string[]> {
  const box = screen.getByRole('combobox', { name });
  fireEvent.mouseDown(box);
  return waitFor(() => {
    const listId = box.getAttribute('aria-controls');
    const dropdown = listId
      ? document.getElementById(listId)?.closest('.ant-select-dropdown')
      : null;
    const options = Array.from(dropdown?.querySelectorAll('.ant-select-item-option') ?? []);
    if (!options.length) throw new Error(`no options in ${name}`);
    return options.map((o) => o.textContent ?? '');
  });
}

/**
 * A dialog found by its title text. A confirmation from App.useApp shows its title twice in the
 * same dialog (the modal's labelled title and the confirm title), so the first match is used.
 */
export async function dialog(title: string | RegExp): Promise<HTMLElement> {
  const [heading] = await screen.findAllByText(title);
  return heading.closest('[role="dialog"]') as HTMLElement;
}

/** Sets a text field at once: typing key by key re-renders the whole form for each key. */
export function fill(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}
