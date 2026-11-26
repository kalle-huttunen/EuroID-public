/**
 * GdprPage: the person picker, the tenant consent report, the empty and error states, and what
 * each role is offered (the GDPR routes: consent list viewer; export, consent changes and report
 * operator; erasure super-admin).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { GdprPage } from '../GdprPage';
import {
  ADA_ID,
  CONSENTS,
  IDENTITY_LIST,
  LEO_ID,
  LEO_LABEL,
  REPORT,
  ada,
  apiError,
  lastListParams,
  loads,
  mockDelete,
  mockGet,
  mockPost,
  pickPerson,
  serve,
} from './GdprPage.fixtures';

// Dev builds (VITE_AUTH_DISABLED) grant every role; the role tests narrow it.
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

describe('GdprPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoles = ['super-admin', 'operator', 'viewer'];
  });

  it(
    'searches the identity list as the operator types and loads the picked person by id',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);

      await pickPerson(user, 'ada.virtanen@');

      // The identity hub's list, searched by the backend, offboarded people included.
      expect(lastListParams()).toEqual({
        _start: 0,
        _end: 50,
        q: 'ada.virtanen@',
        includeDeleted: 'true',
      });
      await waitFor(() =>
        expect(mockGet).toHaveBeenCalledWith(`/api/v1/identity/${ADA_ID}/consent`),
      );
      expect(await screen.findByText('Access export (Articles 15 and 20)')).toBeInTheDocument();
      expect(screen.getByText('Erasure (Article 17)')).toBeInTheDocument();
      expect(screen.getByText('Consent (Article 6)')).toBeInTheDocument();
      expect(screen.getByText(ADA_ID, { selector: 'code' })).toBeInTheDocument();
      expect(screen.queryByText('Offboarded', { selector: '.ant-tag' })).toBeNull();
    },
  );

  it(
    'finds an offboarded person, marks them, and works on them by id',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);

      await pickPerson(user, 'lahti', LEO_LABEL);

      expect(await screen.findByText('Offboarded', { selector: '.ant-tag' })).toBeInTheDocument();
      expect(screen.getByText(LEO_ID, { selector: 'code' })).toBeInTheDocument();
      await waitFor(() =>
        expect(mockGet).toHaveBeenCalledWith(`/api/v1/identity/${LEO_ID}/consent`),
      );
      expect(
        screen.getByText('Offboarded people are included and marked as such.'),
      ).toBeInTheDocument();
    },
  );

  it('asks for a person first and loads nothing about anyone before', async () => {
    serve();
    renderWithProviders(<GdprPage />);

    expect(await screen.findByText('Pick a person')).toBeInTheDocument();
    await waitFor(() => expect(loads(IDENTITY_LIST)).toBe(1));
    expect(screen.queryByText('Access export (Articles 15 and 20)')).toBeNull();
    expect(loads(CONSENTS)).toBe(0);
  });

  it('says how many match when the first 50 are cut off', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...ada,
      _id: `64b7f0c2a1b2c3d4e5f6${String(i).padStart(4, '0')}`,
      email: `person${i}@corp.example`,
    }));
    serve({ identities: many });
    renderWithProviders(<GdprPage />);

    expect(
      await screen.findByText(
        /Showing the first 50 of 60 matches: type more of the name or email to narrow them\./,
      ),
    ).toBeInTheDocument();
  });

  it('shows the API message when the identity list cannot load, and retries', async () => {
    const user = userEvent.setup();
    serve();
    const served = mockGet.getMockImplementation()!;
    let failed = false;
    mockGet.mockImplementation((url: string, config?: unknown) => {
      if (IDENTITY_LIST.test(url) && !failed) {
        failed = true;
        return Promise.reject(apiError(503, 'The identity store is unavailable'));
      }
      return served(url, config);
    });
    renderWithProviders(<GdprPage />);

    expect(await screen.findByText('Could not load the identity list')).toBeInTheDocument();
    expect(screen.getByText('The identity store is unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('combobox', { name: 'Person' })).toBeInTheDocument();
    expect(loads(IDENTITY_LIST)).toBe(2);
  });

  it('shows the tenant consent report per purpose and how many people it covers', async () => {
    serve();
    renderWithProviders(<GdprPage />);

    const card = (await screen.findByText('Consent across the tenant')).closest(
      '.ant-card',
    ) as HTMLElement;
    expect(
      await within(card).findByText('2 people have at least one consent record.'),
    ).toBeInTheDocument();
    const row = within(card).getByText('product analytics').closest('tr') as HTMLElement;
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['product analytics', '2', '0', '0']);
    expect(within(card).getByText(/Nothing marks a consent expired/)).toBeInTheDocument();
  });

  it('shows the API message when the consent report cannot load', async () => {
    serve();
    const served = mockGet.getMockImplementation()!;
    mockGet.mockImplementation((url: string, config?: unknown) =>
      REPORT.test(url) ? Promise.reject(apiError(500, 'Aggregation failed')) : served(url, config),
    );
    renderWithProviders(<GdprPage />);

    expect(await screen.findByText('Could not load the consent report')).toBeInTheDocument();
    expect(screen.getByText('Aggregation failed')).toBeInTheDocument();
  });

  it(
    'offers an operator the export and the consent changes, never the erasure',
    { timeout: 20_000 },
    async () => {
      mockRoles = ['operator', 'viewer'];
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);

      await pickPerson(user, 'Ada');

      expect(await screen.findByRole('button', { name: /Download export/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Record consent/ })).toBeInTheDocument();
      expect(
        await screen.findByRole('button', { name: 'Revoke product analytics' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Erase personal data/ })).toBeNull();
      expect(screen.getByText('Erasure needs the super-admin role.')).toBeInTheDocument();
      expect(mockDelete).not.toHaveBeenCalled();
    },
  );

  it('offers a super-admin the erasure as well', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    serve();
    renderWithProviders(<GdprPage />);

    await pickPerson(user, 'Ada');

    expect(await screen.findByRole('button', { name: /Erase personal data/ })).toBeInTheDocument();
    expect(screen.queryByText('Erasure needs the super-admin role.')).toBeNull();
  });

  it(
    'offers a viewer no action and asks for nothing a viewer is refused',
    { timeout: 20_000 },
    async () => {
      mockRoles = ['viewer'];
      const user = userEvent.setup();
      serve();
      renderWithProviders(<GdprPage />);

      await pickPerson(user, 'Ada');

      // GET /identity/:id/consent is a viewer's: the records are listed without buttons.
      expect(await screen.findByText('product analytics')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Download export/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Record consent/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Revoke/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Grant .* again/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Erase personal data/ })).toBeNull();
      expect(screen.getByText('The export needs the operator role.')).toBeInTheDocument();
      // The consent report is an operator's: not requested, not shown.
      expect(loads(REPORT)).toBe(0);
      expect(screen.queryByText('Consent across the tenant')).toBeNull();
      // GET /identity?includeDeleted=true is refused below operator: not asked for.
      expect(lastListParams()).toEqual({ _start: 0, _end: 50, q: 'Ada' });
      expect(
        screen.getByText('Offboarded people are listed for operators and above only.'),
      ).toBeInTheDocument();
    },
  );
});
