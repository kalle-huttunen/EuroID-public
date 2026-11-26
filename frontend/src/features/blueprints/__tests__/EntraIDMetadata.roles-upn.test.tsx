/**
 * The Entra ID tab of the impact analysis (HX-F2 follow-up): directory roles the policy assigns
 * were typed as groups and listed among them, and without an Entra ID config the person's UPN
 * was shown on an invented domain (euroid.com) as valid. Roles now have their own column, and a
 * UPN the API does not know (null) is shown as not known.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { EntraIDMetadata } from '../components/blueprint/EntraIDMetadata';
import type { IEntraUserMetadata } from '../../../interfaces/impact-analysis.interface';

const ada: IEntraUserMetadata = {
  userId: 'identity-ada',
  displayName: 'Ada Lovelace',
  upn: null,
  upnStatus: 'unknown',
  licenses: [],
  groups: ['Finance Team'],
  roles: ['Global Reader'],
  notKnown: [
    'UPN: not known: the canvas has no Entra ID connector config with a default domain, or the person has no first and last name to form it from.',
  ],
};

describe('EntraIDMetadata roles and an unknown UPN', () => {
  it('lists directory roles in their own column, not among the groups', async () => {
    renderWithProviders(<EntraIDMetadata users={[ada]} />);

    expect(
      await screen.findByRole('columnheader', { name: 'Directory Roles' }),
    ).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    const cellColumn = (text: string) => {
      const cell = screen.getByText(text).closest('td') as HTMLTableCellElement;
      return headers[cell.cellIndex];
    };
    expect(cellColumn('Global Reader')).toBe('Directory Roles');
    expect(cellColumn('Finance Team')).toBe('Groups');
  });

  it('shows a UPN the preview does not know as not known, with no invented one', async () => {
    renderWithProviders(<EntraIDMetadata users={[ada]} />);

    expect(await screen.findByText('UPN not known')).toBeInTheDocument();
    expect(screen.getByText('Not known')).toBeInTheDocument();
    expect(screen.queryByText('Valid')).toBeNull();
    expect(screen.getByText(ada.notKnown[0]!)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('euroid.com');
  });
});
