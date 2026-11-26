/**
 * The Field Mastery table's "Default" column shows the owners the backend uses for a field
 * without an override here: the tenant's default mastery from Admin -> Recon Config. It used to
 * read a frontend list that mirrored a backend DEFAULT_MASTERY which no longer exists, so it could
 * name an owner the backend does not use.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../../test/test-utils';
// The tab's static toasts render under React 19 only with this (index.tsx imports it)
import '../../../../config/antd-react19';
import { IdentityCorrelationTab } from '../IdentityCorrelationTab';
import type { DefaultMasteryView } from '../../../../interfaces';

const activeConnectors = [
  { name: 'entra-id', type: 'target' as const, label: 'Microsoft Entra ID' },
  { name: 'csv-hr', type: 'source' as const, label: 'CSV HR' },
];

function renderTab(defaultMastery: DefaultMasteryView) {
  renderWithProviders(
    <IdentityCorrelationTab
      brainConfig={null}
      activeConnectors={activeConnectors}
      onSave={vi.fn()}
      defaultMastery={defaultMastery}
    />,
  );
}

/** The "Default" cell of a field's row in the Field Mastery table. */
async function defaultOf(field: string): Promise<string | null> {
  const cell = await screen.findByRole('cell', { name: field, exact: true });
  const row = cell.closest('tr') as HTMLElement;
  return within(row).getAllByRole('cell').at(-1)!.textContent;
}

describe('IdentityCorrelationTab Field Mastery defaults', { timeout: 20_000 }, () => {
  it("shows the tenant's default mastery, in priority order, and none where it has no entry", async () => {
    renderTab({
      state: 'loaded',
      mastery: { email: ['entra-id', 'csv-hr'], location: ['workday'] },
    });

    expect(await defaultOf('email')).toBe('Microsoft Entra ID → CSV HR');
    expect(await defaultOf('location')).toBe('workday');
    // The old frontend list named CSV HR here; the backend has no owner for it
    expect(await defaultOf('jobTitle')).toBe('None: primary HR source');
  });

  it('says so when the tenant has no Recon Config', async () => {
    renderTab({ state: 'unconfigured' });

    expect(await defaultOf('email')).toBe('None: Recon Config not set');
  });

  it('says who can read the defaults when this role cannot', async () => {
    renderTab({ state: 'unreadable' });

    expect(await defaultOf('email')).toBe('Recon Config (policy-admin)');
  });
});

/**
 * Contract-critical fields always come from the primary HR contract (owner decision 2026-11-24):
 * the save refuses an owner here that names a secondary HR source or a target for one of them.
 * The tab showed "Failed to save" (and, as the save handler swallowed the error, also "saved").
 */
describe('IdentityCorrelationTab save', { timeout: 20_000 }, () => {
  it("says what the save refused, in the API's words, and claims no success", async () => {
    const reason =
      'Field Mastery: departmentName names entra-id. Contract-critical fields always come from ' +
      'the primary HR contract (now csv-hr); a secondary HR source or a target cannot master them.';
    const onSave = vi.fn().mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { message: reason } },
      }),
    );
    renderWithProviders(
      <IdentityCorrelationTab
        brainConfig={null}
        activeConnectors={activeConnectors}
        onSave={onSave}
        defaultMastery={{ state: 'loaded', mastery: {} }}
      />,
    );

    await userEvent.click(await screen.findByText('Save Identity Correlation Settings'));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Identity correlation settings saved')).toBeNull();
  });

  it('tells which owners a contract-critical field may have', async () => {
    renderTab({ state: 'loaded', mastery: {} });

    expect(
      await screen.findByText(
        /Contract-critical fields \(Recon Config\) always come from the primary/,
      ),
    ).toHaveTextContent('a secondary HR source or a target is refused on save');
  });
});
