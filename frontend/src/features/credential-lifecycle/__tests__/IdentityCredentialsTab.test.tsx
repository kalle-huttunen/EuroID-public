/**
 * The identity page's Credentials tab: one row per system as GET
 * /credential-lifecycle/inventory/:identityId answers it, with MFA for Entra ID and the reason for
 * an account that could not be checked; its empty and error states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { IdentityCredentialsTab } from '../CredentialListTabs';
import { ADA_ID, apiError, soonEntra, unknownAd } from './CredentialLifecyclePage.fixtures';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args) },
}));

describe('IdentityCredentialsTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows each system’s credential, MFA and the reason it could not be checked', async () => {
    mockGet.mockResolvedValue({ data: [soonEntra, unknownAd] });
    renderWithProviders(<IdentityCredentialsTab identityId={ADA_ID} />);

    const table = await screen.findByRole('table', { name: 'Credentials of this identity' });
    const [entra, ad] = within(table).getAllByRole('row').slice(1);
    expect(within(entra).getByText('Entra ID')).toBeInTheDocument();
    expect(within(entra).getByText('Expiring soon')).toBeInTheDocument();
    expect(within(entra).getByText('Enrolled (FIDO2, TOTP)')).toBeInTheDocument();
    expect(within(ad).getByText('Could not be checked')).toBeInTheDocument();
    expect(
      within(ad).getByText('Active Directory is not configured for this tenant'),
    ).toBeInTheDocument();
    expect(within(ad).getByText('Not read')).toBeInTheDocument();
    // No identity column on the identity's own page
    expect(within(table).queryByRole('link')).toBeNull();
    expect(mockGet.mock.calls[0][0]).toMatch(
      new RegExp(`/credential-lifecycle/inventory/${ADA_ID}$`),
    );
  });

  it('says where entries come from when none is recorded', async () => {
    mockGet.mockResolvedValue({ data: [] });
    renderWithProviders(<IdentityCredentialsTab identityId={ADA_ID} />);

    expect(
      await screen.findByText('No credentials recorded for this identity'),
    ).toBeInTheDocument();
    expect(screen.getByText(/after the first nightly check/)).toBeInTheDocument();
  });

  it('shows the API’s message when the credentials cannot be loaded', async () => {
    mockGet.mockRejectedValue(apiError(403, 'Forbidden resource'));
    renderWithProviders(<IdentityCredentialsTab identityId={ADA_ID} />);

    expect(
      await screen.findByText('Could not load this identity’s credentials'),
    ).toBeInTheDocument();
    expect(screen.getByText('Forbidden resource')).toBeInTheDocument();
  });
});
