import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AD_PAYMENTS_DN,
  blockPolicy,
  choose,
  dialog,
  fill,
  LIST,
  listCalls,
  mockDelete,
  mockGet,
  mockPatch,
  mockPost,
  optionsOf,
  renderPage,
  serve,
} from './SodPoliciesPage.fixtures';
import { ConfigProvider } from 'antd';
import { renderWithProviders } from '../../../test/test-utils';
import { SodPolicyFormModal } from '../SodPolicyFormModal';

vi.mock('../../../auth/usePermission', () => ({ usePermission: () => true }));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

const onClose = vi.fn();

/**
 * The New policy modal alone, as the page opens it (no list to render). The first test opens it
 * from the page and checks that the list reloads after a create.
 */
async function openNewPolicy() {
  renderWithProviders(
    <ConfigProvider virtual={false}>
      <SodPolicyFormModal lookup={{ names: new Map(), loadedKinds: new Set() }} onClose={onClose} />
    </ConfigProvider>,
  );
  return dialog('New SoD policy');
}

describe('SodPoliciesPage: create a policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    'creates a policy from catalog values in a centered modal and reloads the list',
    { timeout: 60_000 },
    async () => {
      const user = userEvent.setup();
      serve([blockPolicy]);
      renderPage();
      await screen.findByText('Vendor create vs pay');
      const before = listCalls();

      await user.click(screen.getByRole('button', { name: /New policy/ }));
      const modal = await dialog('New SoD policy');
      expect(document.querySelector('.ant-drawer')).toBeNull();
      expect(modal.closest('.ant-modal-wrap')).toHaveClass('ant-modal-centered');

      fill(within(modal).getByLabelText('Name'), 'Create vs approve payments');
      fill(within(modal).getByLabelText('Description'), 'Four-eyes on payments');
      await choose('Kind of entitlement 1', 'Microsoft Entra ID group');
      // The entitlement picker offers the catalog's entries, not free text.
      expect(await optionsOf('Entitlement 1')).toEqual([
        'Vendor Creategrp-vendor-create',
        'Vendor Paymentsgrp-vendor-pay',
      ]);
      await choose('Entitlement 1', 'Vendor Create');
      await choose('Kind of entitlement 2', 'Active Directory group');
      await choose('Entitlement 2', 'Payment Approvers');
      await user.click(within(modal).getByRole('radio', { name: /^Warn/ }));
      await choose('Severity', 'Medium');

      await user.click(within(modal).getByRole('button', { name: 'Create policy' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(LIST), {
          name: 'Create vs approve payments',
          description: 'Four-eyes on payments',
          severity: 'MEDIUM',
          action: 'WARN',
          isActive: true,
          conflictingEntitlements: [
            { system: 'entra-id', type: 'group', targetId: 'grp-vendor-create' },
            { system: 'ad', type: 'group', targetId: AD_PAYMENTS_DN },
          ],
        }),
      );
      expect(
        await screen.findByText('Policy "Create vs approve payments" created'),
      ).toBeInTheDocument();
      await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
      await waitFor(() => expect(screen.queryByText('New SoD policy')).not.toBeInTheDocument());
    },
  );

  it(
    'refuses an empty side and a repeated entitlement, and drops the duplicate error once it is changed, also to another kind',
    { timeout: 60_000 },
    async () => {
      // The duplicate check ran on submit only, so its error stayed on screen after the
      // entitlement changed, also when a new kind cleared the entitlement.
      const user = userEvent.setup();
      serve([]);
      const modal = await openNewPolicy();
      const duplicate =
        'Entitlement 2 is the same as entitlement 1. A policy needs different entitlements.';

      fill(within(modal).getByLabelText('Name'), 'Self conflict');
      await choose('Kind of entitlement 1', 'Microsoft Entra ID group');
      await choose('Entitlement 1', 'Vendor Create');
      // An empty side is refused: the second side has neither a kind nor an entitlement.
      await user.click(within(modal).getByRole('button', { name: 'Create policy' }));
      expect(await within(modal).findAllByText('Choose the kind of entitlement')).toHaveLength(1);
      expect(within(modal).getByText('Choose an entitlement')).toBeInTheDocument();

      await choose('Kind of entitlement 2', 'Microsoft Entra ID group');
      await choose('Entitlement 2', 'Vendor Create');
      await user.click(within(modal).getByRole('button', { name: 'Create policy' }));
      expect(await within(modal).findByText(duplicate)).toBeInTheDocument();

      await choose('Entitlement 2', 'Vendor Payments');
      await waitFor(() => expect(within(modal).queryByText(duplicate)).toBeNull());

      await choose('Entitlement 2', 'Vendor Create');
      await user.click(within(modal).getByRole('button', { name: 'Create policy' }));
      expect(await within(modal).findByText(duplicate)).toBeInTheDocument();
      await choose('Kind of entitlement 2', 'Active Directory group');
      await waitFor(() => expect(within(modal).queryByText(duplicate)).toBeNull());
      expect(mockPost).not.toHaveBeenCalled();
    },
  );

  it(
    'shows the API message when the backend rejects a new policy',
    { timeout: 60_000 },
    async () => {
      const user = userEvent.setup();
      serve([]);
      mockPost.mockRejectedValue({
        response: {
          status: 400,
          data: {
            message: ['conflictingEntitlements: At least 2 conflicting entitlements required'],
          },
        },
      });
      const modal = await openNewPolicy();
      fill(within(modal).getByLabelText('Name'), 'Rejected');
      await choose('Kind of entitlement 1', 'Microsoft Entra ID group');
      await choose('Entitlement 1', 'Vendor Create');
      await choose('Kind of entitlement 2', 'Microsoft Entra ID group');
      await choose('Entitlement 2', 'Vendor Payments');
      await user.click(within(modal).getByRole('button', { name: 'Create policy' }));

      expect(
        await within(modal).findByText(
          'Could not create the policy: conflictingEntitlements: At least 2 conflicting entitlements required',
        ),
      ).toBeInTheDocument();
      // The modal stays open with what was entered.
      expect(onClose).not.toHaveBeenCalled();
      expect(within(modal).getByLabelText('Name')).toHaveValue('Rejected');
    },
  );

  // Was 'warns when a side is a directory role': since plan 2.9 an access request names a
  // directory role `role` like the policy engine, so a role side is checked everywhere.
  it('offers a directory role side without a caveat', { timeout: 60_000 }, async () => {
    serve([]);
    const modal = await openNewPolicy();

    await choose('Kind of entitlement 1', 'Microsoft Entra ID directory role');
    await choose('Entitlement 1', 'Billing Administrator');
    expect(within(modal).queryByText(/Directory roles are checked only/)).not.toBeInTheDocument();
  });
});
