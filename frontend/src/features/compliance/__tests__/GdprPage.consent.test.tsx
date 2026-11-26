/**
 * GdprPage consent: the picked person's records, recording a grant (also of a revoked purpose
 * again), revoking after a confirmation, the reloads after each, and the API's message on a
 * refusal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import dayjs from 'dayjs';
import { renderWithProviders } from '../../../test/test-utils';
import { GdprPage } from '../GdprPage';
import {
  ADA_ID,
  CONSENTS,
  REPORT,
  apiError,
  confirmDialog,
  expectReloaded,
  loads,
  mockDelete,
  mockGet,
  mockPost,
  modalTitled,
  pickPerson,
  serve,
} from './GdprPage.fixtures';

let mockRoles = ['super-admin', 'operator', 'viewer'];
vi.mock('../../../auth/usePermission', () => ({
  usePermission: (role: string) => mockRoles.includes(role),
}));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

const CONSENT_URL = `/api/v1/identity/${ADA_ID}/consent`;

/** The consent table row of a purpose. */
async function consentRow(purpose: string): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: 'Consent records' });
  return (await within(region).findByText(purpose)).closest('tr') as HTMLElement;
}

describe('GdprPage consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoles = ['super-admin', 'operator', 'viewer'];
  });

  it(
    'lists the records with status, grant, method, expiry and revocation',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);
      await pickPerson(user, 'Ada');

      const granted = await consentRow('product analytics');
      expect(within(granted).getByText('Granted')).toBeInTheDocument();
      expect(within(granted).getByText('2026-10-01')).toBeInTheDocument();
      expect(within(granted).getByText('by operator@corp.example, web-form')).toBeInTheDocument();
      expect(within(granted).getByText('2099-12-31')).toBeInTheDocument();
      expect(
        within(granted).getByRole('button', { name: 'Revoke product analytics' }),
      ).toBeEnabled();

      const revoked = await consentRow('marketing');
      expect(within(revoked).getByText('Revoked')).toBeInTheDocument();
      expect(within(revoked).getByText('2026-09-15')).toBeInTheDocument();
      expect(within(revoked).getByText('No date')).toBeInTheDocument();
      expect(within(revoked).getByRole('button', { name: 'Grant marketing again' })).toBeEnabled();

      // Past its expiry date and still granted: nothing in the backend expires it.
      const lapsed = await consentRow('newsletter');
      expect(within(lapsed).getByText('Granted')).toBeInTheDocument();
      expect(within(lapsed).getByText('Past expiry')).toBeInTheDocument();
      expect(within(granted).queryByText('Past expiry')).toBeNull();

      expect(screen.getByText(/No other part of EuroID reads these records/)).toBeInTheDocument();
    },
  );

  it(
    'keeps the consent table in a horizontal scroll container with fixed columns',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);
      await pickPerson(user, 'Ada');

      const table = (await consentRow('marketing')).closest('table') as HTMLElement;
      expect(table.style.tableLayout).toBe('fixed');
      expect(table.style.width).toBe('820px');
      expect((table.closest('.ant-table-content') as HTMLElement).style.overflowX).toBe('auto');
    },
  );

  it(
    'records a consent with purpose, method and expiry as the API takes them, then reloads',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);
      await pickPerson(user, 'Ada');
      await consentRow('marketing');
      const consentsBefore = loads(CONSENTS);
      const reportBefore = loads(REPORT);

      await user.click(screen.getByRole('button', { name: /Record consent/ }));
      const modal = await modalTitled('Record consent');
      await user.click(within(modal).getByLabelText('Purpose'));
      await user.paste('  research  ');
      await user.click(within(modal).getByLabelText('How it was collected'));
      await user.paste('contract');
      await user.click(within(modal).getByLabelText('Expires'));
      await user.paste('2099-12-31');
      await user.keyboard('{Enter}');
      await user.click(within(modal).getByRole('button', { name: 'Record consent' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(CONSENT_URL, {
          purpose: 'research',
          method: 'contract',
          expiresAt: dayjs('2099-12-31').endOf('day').toISOString(),
        }),
      );
      expect(await screen.findByText('Consent for research recorded.')).toBeInTheDocument();
      await expectReloaded(CONSENTS, consentsBefore);
      await expectReloaded(REPORT, reportBefore);
    },
  );

  it('grants a revoked purpose again with the purpose fixed', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<GdprPage />);
    await pickPerson(user, 'Ada');

    await user.click(
      within(await consentRow('marketing')).getByRole('button', { name: 'Grant marketing again' }),
    );
    const modal = await modalTitled('Grant marketing again');
    expect(within(modal).getByLabelText('Purpose')).toBeDisabled();
    expect(within(modal).getByText(/a revocation is cleared/)).toBeInTheDocument();
    await user.click(within(modal).getByRole('button', { name: 'Record consent' }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(CONSENT_URL, { purpose: 'marketing' }),
    );
    expect(await screen.findByText('Consent for marketing recorded.')).toBeInTheDocument();
  });

  it(
    'shows the API message when a grant is refused, and keeps the form',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      // A role taken away since the page loaded: the roles guard's own message.
      mockPost.mockRejectedValue(apiError(403, 'Requires one of: super-admin, operator'));
      renderWithProviders(<GdprPage />);
      await pickPerson(user, 'Ada');

      await user.click(await screen.findByRole('button', { name: /Record consent/ }));
      const modal = await modalTitled('Record consent');
      await user.click(within(modal).getByLabelText('Purpose'));
      await user.paste('research');
      await user.click(within(modal).getByRole('button', { name: 'Record consent' }));

      expect(
        await within(modal).findByText(
          'Consent not recorded: Requires one of: super-admin, operator',
        ),
      ).toBeInTheDocument();
      expect(within(modal).getByLabelText('Purpose')).toHaveValue('research');
    },
  );

  it(
    'revokes after a confirmation that says what stays, then reloads',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);
      await pickPerson(user, 'Ada');
      const row = await consentRow('product analytics');
      const consentsBefore = loads(CONSENTS);

      await user.click(within(row).getByRole('button', { name: 'Revoke product analytics' }));
      const dialog = await confirmDialog('Revoke consent for product analytics?');
      expect(within(dialog).getByText(/The record stays, with status revoked/)).toBeInTheDocument();
      expect(mockDelete).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole('button', { name: 'Revoke consent' }));

      // The purpose travels in the path, encoded.
      await waitFor(() =>
        expect(mockDelete).toHaveBeenCalledWith(`${CONSENT_URL}/product%20analytics`),
      );
      expect(await screen.findByText('Consent for product analytics revoked.')).toBeInTheDocument();
      await expectReloaded(CONSENTS, consentsBefore);
    },
  );

  it('shows the API message when a revoke is refused', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve();
    mockDelete.mockRejectedValue(
      apiError(404, `No consent found for identity ${ADA_ID}, purpose product analytics`),
    );
    renderWithProviders(<GdprPage />);
    await pickPerson(user, 'Ada');

    await user.click(
      within(await consentRow('product analytics')).getByRole('button', {
        name: 'Revoke product analytics',
      }),
    );
    const dialog = await confirmDialog('Revoke consent for product analytics?');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke consent' }));

    expect(
      await screen.findByText(
        `Revoke failed: No consent found for identity ${ADA_ID}, purpose product analytics`,
      ),
    ).toBeInTheDocument();
  });

  it(
    'says so when the person has no consent record, and offers to record one',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve({ consents: [] });
      renderWithProviders(<GdprPage />);
      await pickPerson(user, 'Ada');

      expect(await screen.findByText('No consent recorded for this person')).toBeInTheDocument();
      const region = screen.getByRole('region', { name: 'Consent records' });
      await user.click(within(region).getByRole('button', { name: 'Record consent' }));
      expect(await modalTitled('Record consent')).toBeInTheDocument();
    },
  );

  it('shows the API message when the records cannot load', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve();
    const served = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url: string, config?: unknown) =>
      CONSENTS.test(url)
        ? Promise.reject(apiError(500, 'Consent store unavailable'))
        : served(url, config),
    );
    renderWithProviders(<GdprPage />);
    await pickPerson(user, 'Ada');

    expect(await screen.findByText('Could not load the consent records')).toBeInTheDocument();
    expect(screen.getByText('Consent store unavailable')).toBeInTheDocument();
  });
});
