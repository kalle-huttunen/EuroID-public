/**
 * The Entra ID tab of the impact analysis showed hard-coded licenses ("O365_E3 - Microsoft 365
 * E3", 250 available), groups and conditional access policies (r2-05 N9). It now shows what the
 * API derives from the policy intent: the groups and licenses the policy assigns, a license's
 * units left when discovery has read them, and what the preview does not know.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { EntraIDMetadata } from '../components/blueprint/EntraIDMetadata';
import type { IEntraUserMetadata } from '../../../interfaces/impact-analysis.interface';

const users: IEntraUserMetadata[] = [
  {
    userId: 'identity-ada',
    displayName: 'Ada Lovelace',
    upn: 'ada.lovelace@corp.example',
    upnStatus: 'valid',
    licenses: [
      { sku: 'ENTERPRISEPACK', name: 'ENTERPRISEPACK', assigned: true, available: 5 },
      { sku: 'POWER_BI_PRO', name: 'POWER_BI_PRO', assigned: true, available: null },
    ],
    groups: ['Finance Team', 'Contractors'],
    notKnown: [
      'Conditional access policies: EuroID does not read them, so which apply is not shown.',
      'Units left of license POWER_BI_PRO: not known until Entra ID discovery has read it.',
    ],
  },
];

describe('EntraIDMetadata from the policy intent', () => {
  it('shows the groups and licenses the policy assigns and what is not known', async () => {
    renderWithProviders(<EntraIDMetadata users={users} />);

    expect(await screen.findByText('Finance Team')).toBeInTheDocument();
    expect(screen.getByText('Contractors')).toBeInTheDocument();
    expect(screen.getByText('ENTERPRISEPACK')).toBeInTheDocument();
    expect(screen.getByText('POWER_BI_PRO')).toBeInTheDocument();
    expect(screen.getByText('What this preview does not know')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Units left of license POWER_BI_PRO: not known until Entra ID discovery has read it.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Conditional Access')).toBeNull();
    expect(screen.queryByText(/O365 Groups/)).toBeNull();
    // A license whose units are not known is no shortage
    expect(screen.queryByText('License Shortage Detected')).toBeNull();
  });
});
