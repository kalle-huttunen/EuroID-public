import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../../test/test-utils';
import { PolicyTraceModal } from '../PolicyTraceModal';
import { DriftActionPanel } from '../DriftActionPanel';
import { axiosInstance } from '@api/data';
import { fetchDrifts } from '@api/reconciliation-api';
import type { PolicyProvisioningIntent } from '@api/identity-map-api';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn(), post: vi.fn() },
}));

const get = vi.mocked(axiosInstance.get);
const post = vi.mocked(axiosInstance.post);

const intent: PolicyProvisioningIntent = {
  operations: [
    {
      type: 'group',
      action: 'add',
      target: 'entra-id',
      targetId: 'SG-Finance',
      sourcePolicy: 'Finance access',
      timeConstraint: { durationDays: 30 },
    },
  ],
};

// A drift as GET /reconciliation/drifts sends it: `_id`, no `id`. The map gets its drifts through
// fetchDrifts, as here.
const apiDrift = {
  _id: '6650a1b2c3d4e5f6a7b8c9d0',
  tenantId: 'dev-tenant',
  type: 'FIELD_MISMATCH',
  severity: 'high',
  userId: 'u1',
  userDisplayName: 'Maija M',
  userEmail: 'm•••@corp.example',
  targetSystem: 'entra-id',
  field: 'jobTitle',
  hubValue: 'Lead analyst',
  targetValue: 'Analyst',
  detectedAt: '2026-11-22T10:00:00.000Z',
  autoCorrectEligible: true,
  status: 'open',
  __v: 0,
};

// 3.dn: the owner chose centered modals over side drawers for these read-and-act views.
describe('Entitlement map modals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({
      data: { success: true, drifts: [apiDrift], total: 1, page: 1, limit: 50, totalPages: 1 },
    });
    post.mockResolvedValue({ data: { success: true } });
  });

  it('shows the policy trace of an entitlement in a centered modal', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <PolicyTraceModal
        open
        entitlement={{
          name: 'SG-Finance',
          type: 'Group',
          origin: 'POLICY',
          governanceLevel: 'STRICT',
          sourcePolicy: 'Finance access',
          isProvisioned: true,
        }}
        policyIntent={intent}
        onClose={onClose}
      />,
    );

    expect(await screen.findByText('Policy Trace: SG-Finance')).toBeInTheDocument();
    expect(document.querySelector('.ant-drawer')).toBeNull();
    const modal = document.querySelector('.ant-modal') as HTMLElement;
    expect(modal).toHaveStyle({ width: '560px' });
    expect(modal.querySelector('.ant-modal-footer')).toBeNull();
    expect(within(modal).getByText('ADD')).toBeInTheDocument();
    expect(within(modal).getByText('Duration: 30 days')).toBeInTheDocument();

    await user.click(within(modal).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the end date of access an access request granted, on any identity's map", async () => {
    // The chip of a request grant from GET /identity/:id/entitlements (useEntitlementGraph)
    renderWithProviders(
      <PolicyTraceModal
        open
        entitlement={{
          name: 'example/engineering',
          type: 'Group',
          origin: 'REQUEST',
          isProvisioned: true,
          expiresAt: '2027-06-01T00:00:00.000Z',
        }}
        policyIntent={null}
        onClose={() => {}}
      />,
    );

    const modal = (await screen.findByText('Policy Trace: example/engineering')).closest(
      '.ant-modal',
    ) as HTMLElement;
    const date = new Date('2027-06-01T00:00:00.000Z').toLocaleDateString();
    expect(within(modal).getByText(`Expires: ${date}`)).toBeInTheDocument();
  });

  it('says when an access review revoked a grant the policies still make', async () => {
    // GET /policy/evaluate/:identityId with an active access review exclusion of SG-Payables;
    // the same policy still grants SG-Finance
    const withExclusion: PolicyProvisioningIntent = {
      operations: intent.operations,
      suppressedOperations: [
        {
          type: 'group',
          action: 'add',
          target: 'entra-id',
          targetId: 'SG-Payables',
          sourcePolicy: 'Finance access',
          suppressedBy: {
            reason: 'Suppressed by access review',
            exclusionId: '64b7f0c2a1b2c3d4e5f60b01',
            campaignId: 'c0a80101-0000-4000-8000-000000000001',
          },
        },
      ],
    };
    renderWithProviders(
      <PolicyTraceModal
        open
        entitlement={{
          name: 'SG-Payables',
          type: 'Group',
          origin: 'POLICY',
          sourcePolicy: 'Finance access',
          isProvisioned: false,
        }}
        policyIntent={withExclusion}
        onClose={() => {}}
      />,
    );

    const modal = (await screen.findByText('Policy Trace: SG-Payables')).closest(
      '.ant-modal',
    ) as HTMLElement;
    expect(within(modal).getByText('SUPPRESSED')).toBeInTheDocument();
    expect(within(modal).getByText('Suppressed by access review')).toBeInTheDocument();
    expect(within(modal).queryByText('ADD')).toBeNull();
  });

  it(
    "lists a system's drifts in a centered modal and corrects one after confirmation",
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      const drifts = await fetchDrifts({ identityId: 'u1' });
      renderWithProviders(
        <DriftActionPanel
          open
          targetSystem="entra-id"
          drifts={drifts}
          identityId="u1"
          onClose={() => {}}
        />,
      );

      expect(await screen.findByText('Drift Details: entra-id')).toBeInTheDocument();
      expect(document.querySelector('.ant-drawer')).toBeNull();
      const modal = document.querySelector('.ant-modal') as HTMLElement;
      expect(modal).toHaveStyle({ width: '640px' });
      expect(within(modal).getByText('Hub: Lead analyst → Target: Analyst')).toBeInTheDocument();

      await user.click(within(modal).getByRole('button', { name: /Correct$/ }));
      // antd also puts the confirm's title in a hidden modal title; match the visible one.
      const confirm = (
        await screen.findByText('Correct Drift?', { selector: '.ant-modal-confirm-title' })
      ).closest('.ant-modal') as HTMLElement;
      await user.click(within(confirm).getByRole('button', { name: /^Correct$/ }));

      await waitFor(() =>
        expect(post).toHaveBeenCalledWith(
          '/api/v1/reconciliation/drifts/6650a1b2c3d4e5f6a7b8c9d0/correct',
        ),
      );
      expect(post).toHaveBeenCalledTimes(1);
    },
  );
});
