/**
 * The Policy Engine page's action row offers the target systems the connector registry gives
 * policy actions (the same ones as the Design studio's node rail), under their registry names,
 * and All Systems. It used to offer Salesforce, which EuroID has no connector for, and lacked
 * SCIM. An older policy's `active-directory` target still shows as Active Directory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { renderWithProviders } from '../../../test/test-utils';
import { ActionRow } from '../ActionRow';
import type { PolicyAction } from '../types';
import { POLICY_ACTION_CONNECTORS } from '@features/blueprints/shared';
import { axiosInstance } from '@api/data';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn().mockResolvedValue({ data: [] }) },
}));

function renderRow(action: PolicyAction, updateAction = vi.fn()) {
  const result = renderWithProviders(
    // Without virtual scrolling, so jsdom renders every option of the dropdown.
    <ConfigProvider virtual={false}>
      <ActionRow
        action={action}
        idx={0}
        catalogGroups={[]}
        catalogRoles={[]}
        updateAction={updateAction}
        removeAction={vi.fn()}
        fetchCatalog={vi.fn()}
        fetchCatalogRoles={vi.fn()}
        getTargetIcon={() => null}
      />
    </ConfigProvider>,
  );
  return { ...result, updateAction };
}

const assignGroup = (target: PolicyAction['target']): PolicyAction => ({
  id: 'a1',
  type: 'assign_group',
  target,
  params: {},
});

async function offeredTargets(container: HTMLElement): Promise<string[]> {
  fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Target system' }));
  await screen.findAllByRole('listbox');
  return Array.from(container.ownerDocument.querySelectorAll('.ant-select-item-option')).map(
    (option) => option.textContent?.trim() ?? '',
  );
}

describe('ActionRow target systems', () => {
  it('offers the registry targets with policy actions and All Systems, no Salesforce', async () => {
    const { container } = renderRow(assignGroup('entra-id'));

    const offered = await offeredTargets(container);

    expect(offered).toEqual([...POLICY_ACTION_CONNECTORS.map((c) => c.name), 'All Systems']);
    expect(offered).toContain('Active Directory');
    expect(offered).toContain('Microsoft Entra ID');
    expect(offered).not.toContain('Salesforce');
  });

  it('saves the registry id of the chosen target', async () => {
    const { container, updateAction } = renderRow(assignGroup('entra-id'));
    await offeredTargets(container);

    const ad = Array.from(container.ownerDocument.querySelectorAll('.ant-select-item-option')).find(
      (option) => option.textContent?.trim() === 'Active Directory',
    );
    fireEvent.click(ad as Element);

    expect(updateAction).toHaveBeenCalledWith('a1', { target: 'ad' });
  });

  it("shows an older policy's active-directory target as Active Directory", () => {
    const { container } = renderRow(assignGroup('active-directory'));

    expect(container.querySelector('.ant-select-selection-item')?.textContent?.trim()).toBe(
      'Active Directory',
    );
  });
});

/**
 * The license picker offers the licenses connector discovery put in the entitlement catalog and
 * stores the entry's nativeId, the Entra ID skuPartNumber the connector assigns by and SoD
 * policies name. It used to offer fixed names such as O365_E3, which are no skuPartNumber.
 */
describe('ActionRow license picker', () => {
  const assignLicense = (licenseSku?: string): PolicyAction => ({
    id: 'a1',
    type: 'assign_license',
    target: 'entra-id',
    params: licenseSku ? { licenseSku } : {},
  });

  beforeEach(() => {
    vi.mocked(axiosInstance.get).mockImplementation(async (_url: string, config?: unknown) => {
      const params = (config as { params?: { type?: string } } | undefined)?.params;
      return params?.type === 'License'
        ? {
            data: {
              entitlements: [
                { nativeId: 'ENTERPRISEPACK', name: 'Office 365 E3', type: 'License' },
                { nativeId: 'SPE_E5', name: 'Microsoft 365 E5', type: 'License' },
              ],
            },
          }
        : { data: [] };
    });
  });

  const offeredLicenses = async (container: HTMLElement) => {
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'License SKU' }));
    await waitFor(() =>
      expect(
        container.ownerDocument.querySelectorAll('.ant-select-item-option').length,
      ).toBeGreaterThan(0),
    );
    return Array.from(container.ownerDocument.querySelectorAll('.ant-select-item-option'));
  };

  it('offers the catalog licenses and stores the skuPartNumber', async () => {
    const { container, updateAction } = renderRow(assignLicense());

    const options = await offeredLicenses(container);
    expect(options.map((o) => o.textContent?.trim())).toEqual([
      'Office 365 E3',
      'Microsoft 365 E5',
    ]);
    expect(container.ownerDocument.body.textContent).not.toContain('O365_E3');

    fireEvent.click(options[0]);
    expect(updateAction).toHaveBeenCalledWith('a1', { params: { licenseSku: 'ENTERPRISEPACK' } });
  });

  it('keeps a stored SKU the catalog does not hold visible as such', async () => {
    renderRow(assignLicense('O365_E3'));

    const licenseSelect = () =>
      screen.getByRole('combobox', { name: 'License SKU' }).closest('.ant-select');
    await waitFor(() =>
      expect(licenseSelect()?.querySelector('.ant-select-selection-item')?.textContent).toBe(
        'O365_E3 (not in the entitlement catalog)',
      ),
    );
  });
});
