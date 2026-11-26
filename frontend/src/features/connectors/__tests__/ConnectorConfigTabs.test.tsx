import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/test-utils';
import { ConnectorConfigTabs } from '../ConnectorConfigTabs';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn(), post: (...args: unknown[]) => mockPost(...args) },
}));

vi.mock('@api/constants', () => ({ API_BASE: '/api/v1' }));

const AD = {
  id: 'ad',
  name: 'Active Directory',
  configSchema: [
    { key: 'host', label: 'Host / IP', type: 'text' as const, tab: 'Connection' },
    { key: 'password', label: 'Password', type: 'password' as const, tab: 'Connection' },
  ],
};

/**
 * Test Connection (AD) sends the form's values to POST /connectors/ad/health-check. The API
 * refuses a masked password with a changed host (it sends a stored secret only to the saved
 * destination), and its reason is what the admin must see, not "status code 400".
 */
describe('ConnectorConfigTabs: Test Connection', () => {
  it('shows why the API refused the check', { timeout: 20_000 }, async () => {
    const reason =
      'Type password again to test a changed host: a stored secret is only sent to the saved ' +
      'destination';
    mockPost.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { status: 400, data: { message: reason } },
      }),
    );
    renderWithProviders(
      <ConnectorConfigTabs
        connectorMeta={AD}
        connectorId="ad"
        values={{ host: 'dc02.corp.example', password: '••••••••' }}
        onChange={() => undefined}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Test Connection/ }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/connectors/ad/health-check', {
        config: { host: 'dc02.corp.example', password: '••••••••' },
      }),
    );
    expect((await screen.findAllByText(reason)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/status code 400/)).not.toBeInTheDocument();
  });
});
