import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { LeaverItemsTable } from '../LeaverItemsTable';
import type { ILeaverBatchItem, ILeaverOffboardingResult } from '../../../interfaces';

let mockIsPolicyAdmin = true;
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => (role === 'policy-admin' ? mockIsPolicyAdmin : true),
}));

const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: vi.fn(() => Promise.resolve({ data: [] })),
    post: (...args: unknown[]) => mockPost(...args),
    put: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockIsPolicyAdmin = true;
  mockPost.mockResolvedValue({ data: {} });
});

const base: ILeaverBatchItem = {
  leaverEventId: 'le-1',
  identityId: 'id-1',
  displayName: 'Ada Lovelace',
  reason: 'terminated',
  status: 'started',
  workflowId: 't-tenant-a-offboard-id-1',
};

describe('LeaverItemsTable offboarding column', () => {
  it('shows what offboarding did in each target and that the Golden Record is suspended', async () => {
    renderWithProviders(
      <LeaverItemsTable
        items={[
          {
            ...base,
            offboarding: {
              status: 'partial-failure',
              hubStatus: 'suspended',
              finishedAt: '2026-11-22T10:00:00.000Z',
              systems: [
                { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
                { system: 'scim', outcome: 'already-gone', detail: 'no such user' },
                { system: 'file-outbound', outcome: 'not-applicable', reason: 'keeps no account' },
                {
                  system: 'github',
                  outcome: 'failed',
                  reason: 'github: remove them from the organization in GitHub',
                },
              ],
            },
          },
        ]}
      />,
    );

    const row = screen.getByText('Ada Lovelace').closest('tr') as HTMLElement;
    expect(within(row).getByText('okta: Access removed')).toBeInTheDocument();
    expect(within(row).getByText('scim: No account left')).toBeInTheDocument();
    expect(within(row).getByText('file-outbound: Not applicable')).toBeInTheDocument();
    expect(within(row).getByText('github: Failed')).toBeInTheDocument();
    expect(
      within(row).getByText('Golden Record suspended: a target still has access'),
    ).toBeInTheDocument();

    await userEvent.hover(within(row).getByText('github: Failed'));
    expect(
      await screen.findByText('github: remove them from the organization in GitHub'),
    ).toBeInTheDocument();
  });

  it('fits the page width: fixed columns, the offboarding tags wrap instead of widening it', () => {
    // 2.0co: the table was sized to its content, so at 1440 px it scrolled sideways.
    renderWithProviders(<LeaverItemsTable items={[base]} />);
    const table = screen.getByText('Ada Lovelace').closest('table')!;
    expect(table.style.tableLayout).toBe('fixed');
    expect(table.style.width).not.toBe('max-content');
  });

  it('says on its status why a queued member did not start, as the joiner page does', async () => {
    renderWithProviders(
      <LeaverItemsTable
        items={[
          {
            ...base,
            status: 'queued',
            workflowId: undefined,
            startError: 'Temporal is not connected.',
          },
        ]}
      />,
    );

    const row = screen.getByText('Ada Lovelace').closest('tr') as HTMLElement;
    await userEvent.hover(within(row).getByText('Queued to start'));
    expect(await screen.findByText('Temporal is not connected.')).toBeInTheDocument();
  });

  it('shows a started offboarding without a result as running', () => {
    renderWithProviders(<LeaverItemsTable items={[base]} />);
    const row = screen.getByText('Ada Lovelace').closest('tr') as HTMLElement;
    expect(within(row).getByText('Running')).toBeInTheDocument();
  });

  it("shows each linked admin account the person's offboarding reached, and why one failed", async () => {
    renderWithProviders(
      <LeaverItemsTable
        items={[
          {
            ...base,
            offboarding: {
              status: 'partial-failure',
              hubStatus: 'suspended',
              finishedAt: '2026-11-25T10:00:00.000Z',
              systems: [{ system: 'entra', outcome: 'deprovisioned', detail: 'deleted' }],
              linkedAdmins: [
                { identityId: 'adm-0', workflowId: 'wf-adm-0', outcome: 'offboarded' },
                {
                  identityId: 'adm-1',
                  workflowId: 'wf-adm-1',
                  outcome: 'failed',
                  reason: 'entra-id: Insufficient privileges (HTTP 403)',
                },
                { identityId: 'adm-2', workflowId: 'wf-adm-2', outcome: 'running-elsewhere' },
              ],
            },
          },
        ]}
      />,
    );

    const row = screen.getByText('Ada Lovelace').closest('tr') as HTMLElement;
    expect(within(row).getByText('Admin account: Offboarded')).toBeInTheDocument();
    expect(within(row).getByText('Admin account: Offboarding elsewhere')).toBeInTheDocument();
    expect(
      within(row).getByText(
        'Golden Record suspended: a target or admin account may still have access',
      ),
    ).toBeInTheDocument();

    await userEvent.hover(within(row).getByText('Admin account: Failed'));
    expect(
      await screen.findByText(
        'Linked admin identity adm-1: entra-id: Insufficient privileges (HTTP 403)',
      ),
    ).toBeInTheDocument();
  });

  it('says the Golden Record was deleted when every target is done', () => {
    renderWithProviders(
      <LeaverItemsTable
        items={[
          {
            ...base,
            offboarding: {
              status: 'completed',
              hubStatus: 'deleted',
              finishedAt: '2026-11-22T10:00:00.000Z',
              systems: [{ system: 'entra', outcome: 'deprovisioned', detail: 'deleted' }],
            },
          },
        ]}
      />,
    );
    expect(screen.getByText('Golden Record deleted')).toBeInTheDocument();
  });
});

describe('LeaverItemsTable: failed target removed manually', () => {
  const twoFailed: ILeaverOffboardingResult = {
    status: 'partial-failure',
    hubStatus: 'suspended',
    finishedAt: '2026-11-22T10:00:00.000Z',
    systems: [
      { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
      { system: 'github', outcome: 'failed', reason: 'github: remove them in GitHub' },
      { system: 'servicenow', outcome: 'failed', reason: 'servicenow: no sys_user record' },
    ],
  };

  it('offers the action only next to failed targets', () => {
    renderWithProviders(<LeaverItemsTable items={[{ ...base, offboarding: twoFailed }]} />);
    expect(
      screen.getByRole('button', { name: 'Mark github removed manually' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark servicenow removed manually' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark okta/ })).not.toBeInTheDocument();
  });

  it('offers no action for a member without a workflow id', () => {
    renderWithProviders(
      <LeaverItemsTable items={[{ ...base, workflowId: undefined, offboarding: twoFailed }]} />,
    );
    expect(screen.queryByRole('button', { name: /removed manually/ })).not.toBeInTheDocument();
  });

  it('offers no action below policy-admin', () => {
    mockIsPolicyAdmin = false;
    renderWithProviders(<LeaverItemsTable items={[{ ...base, offboarding: twoFailed }]} />);
    expect(screen.queryByRole('button', { name: /removed manually/ })).not.toBeInTheDocument();
  });

  it(
    'records it only with a note, for that offboarding and target',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      renderWithProviders(<LeaverItemsTable items={[{ ...base, offboarding: twoFailed }]} />);

      await user.click(screen.getByRole('button', { name: 'Mark github removed manually' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/not as removed by EuroID/)).toBeInTheDocument();
      expect(within(dialog).queryByText(/last failed target/)).not.toBeInTheDocument();
      const ok = within(dialog).getByRole('button', { name: 'Record as removed manually' });
      expect(ok).toBeDisabled();

      await user.type(within(dialog).getByLabelText('Removal note'), 'Removed from acme today');
      await user.click(ok);

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          '/api/v1/leavers/offboardings/t-tenant-a-offboard-id-1/removed-manually',
          { system: 'github', reason: 'Removed from acme today' },
        ),
      );
    },
  );

  it(
    'shows why the API refused closing the target and keeps the dialog open',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      const refusal =
        'github stays failed: closing it would delete a person whose linked admin identity ' +
        'adm-1 is still live. Offboard that admin account first (its own offboarding), then ' +
        'close this target.';
      mockPost.mockRejectedValueOnce({ response: { status: 409, data: { message: refusal } } });
      const oneFailed = { ...twoFailed, systems: twoFailed.systems.slice(0, 2) };
      renderWithProviders(<LeaverItemsTable items={[{ ...base, offboarding: oneFailed }]} />);

      await user.click(screen.getByRole('button', { name: 'Mark github removed manually' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText('Removal note'), 'Removed from acme today');
      await user.click(within(dialog).getByRole('button', { name: 'Record as removed manually' }));

      expect(await screen.findByText(refusal)).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    },
  );

  it('ends the failure reason with a full stop before the instructions', async () => {
    const user = userEvent.setup();
    const rateLimited: ILeaverOffboardingResult = {
      ...twoFailed,
      systems: [
        { system: 'okta', outcome: 'failed', reason: 'Okta API rate limit exceeded' },
        { system: 'github', outcome: 'failed', reason: 'github: remove them in GitHub' },
      ],
    };
    renderWithProviders(<LeaverItemsTable items={[{ ...base, offboarding: rateLimited }]} />);

    await user.click(screen.getByRole('button', { name: 'Mark okta removed manually' }));
    const dialog = await screen.findByRole('dialog');
    const [reason, instructions] = within(dialog).getAllByText(
      (_, el) => el?.tagName === 'DIV' && el.classList.contains('ant-typography'),
    );
    expect(reason.textContent).toBe(
      "EuroID could not remove Ada Lovelace's access in okta: Okta API rate limit exceeded.",
    );
    expect(instructions.textContent).toMatch(/^Confirm only after you have removed the account/);
  });

  it('does not add a second full stop to a reason that has one', async () => {
    const user = userEvent.setup();
    const withStop: ILeaverOffboardingResult = {
      ...twoFailed,
      systems: [{ system: 'github', outcome: 'failed', reason: 'github: remove them in GitHub.' }],
    };
    renderWithProviders(<LeaverItemsTable items={[{ ...base, offboarding: withStop }]} />);
    await user.click(screen.getByRole('button', { name: 'Mark github removed manually' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/github: remove them in GitHub\.$/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/GitHub\.\./)).not.toBeInTheDocument();
  });

  it('warns that closing the last failed target deletes the Golden Record', async () => {
    const user = userEvent.setup();
    const oneFailed = { ...twoFailed, systems: twoFailed.systems.slice(0, 2) };
    renderWithProviders(<LeaverItemsTable items={[{ ...base, offboarding: oneFailed }]} />);
    await user.click(screen.getByRole('button', { name: 'Mark github removed manually' }));
    expect(await screen.findByText(/Golden Record is\s+deleted/)).toBeInTheDocument();
  });

  it('does not say closing the last failed target deletes the Golden Record while an admin account failed', async () => {
    const user = userEvent.setup();
    const oneFailed: ILeaverOffboardingResult = {
      ...twoFailed,
      systems: twoFailed.systems.slice(0, 2),
      linkedAdmins: [
        { identityId: 'adm-1', workflowId: 'wf-adm-1', outcome: 'failed', reason: 'entra: 403' },
      ],
    };
    renderWithProviders(<LeaverItemsTable items={[{ ...base, offboarding: oneFailed }]} />);
    await user.click(screen.getByRole('button', { name: 'Mark github removed manually' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/last failed target/)).not.toBeInTheDocument();
  });

  it('shows a closed target as removed manually, with who, when and why', async () => {
    renderWithProviders(
      <LeaverItemsTable
        items={[
          {
            ...base,
            offboarding: {
              status: 'completed',
              hubStatus: 'deleted',
              finishedAt: '2026-11-22T10:00:00.000Z',
              systems: [
                {
                  system: 'github',
                  outcome: 'removed-manually',
                  reason: 'github: remove them in GitHub',
                  manualRemoval: {
                    by: 'admin@corp.example',
                    at: '2026-11-22T11:00:00.000Z',
                    reason: 'Removed from acme',
                  },
                },
              ],
            },
          },
        ]}
      />,
    );
    const tag = screen.getByText('github: Removed manually');
    expect(screen.queryByText(/Access removed/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /removed manually/ })).not.toBeInTheDocument();
    await userEvent.hover(tag);
    expect(
      await screen.findByText(/Removed manually by admin@corp.example on .*: Removed from acme/),
    ).toBeInTheDocument();
  });
});
