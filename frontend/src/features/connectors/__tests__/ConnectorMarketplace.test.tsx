import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { ConnectorMarketplace } from '../ConnectorMarketplace';

const { store, mockGet } = vi.hoisted(() => ({
  store: {
    installed: [] as Array<{ connectorName: string }>,
    isInstalled: (() => false) as (name: string) => boolean,
    install: (() => Promise.resolve()) as (name: string, config: object) => Promise<void>,
    uninstall: (() => Promise.resolve()) as (name: string) => Promise<void>,
    syncFromBackend: (() => Promise.resolve()) as () => Promise<void>,
    syncError: null as unknown,
  },
  mockGet: vi.fn(),
}));

vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn(), delete: vi.fn() },
}));

vi.mock('@api/constants', () => ({
  API_BASE: '/api/v1',
}));

vi.mock('@stores/connector-store', () => ({
  useConnectorStore: () => store,
}));

vi.mock('../../auth', () => ({
  usePermission: vi.fn().mockReturnValue(true),
}));

vi.mock('../connector-icons', () => ({
  getConnectorIcon: vi.fn().mockReturnValue(null),
}));

const OKTA = {
  id: 'okta',
  name: 'Okta',
  description: 'Okta users and groups',
  capabilities: ['provision'],
  icon: 'okta',
  configSchema: [],
};

/** An axios error as the API answers it: the reason in response.data.message. */
function apiError(status: number, message: string) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { message } },
  });
}

describe('ConnectorMarketplace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: [OKTA] });
    store.installed = [];
    store.isInstalled = () => false;
    store.install = () => Promise.resolve();
    store.uninstall = () => Promise.resolve();
    store.syncFromBackend = vi.fn(() => Promise.resolve());
    store.syncError = null;
  });

  it('renders without crashing', () => {
    renderWithProviders(<ConnectorMarketplace />);
    expect(screen.getAllByText(/connector/i).length).toBeGreaterThan(0);
  });

  it("shows the API's reason when the backend refuses an install", async () => {
    store.install = vi.fn(() => Promise.reject(apiError(400, 'config.orgUrl: Required')));
    renderWithProviders(<ConnectorMarketplace />);

    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

    expect(await screen.findByText('config.orgUrl: Required')).toBeInTheDocument();
    expect(store.install).toHaveBeenCalledWith('okta', {});
  });

  it("shows the API's reason when the backend refuses an uninstall", async () => {
    store.installed = [{ connectorName: 'okta' }];
    store.isInstalled = () => true;
    store.uninstall = vi.fn(() => Promise.reject(apiError(403, 'Forbidden resource')));
    renderWithProviders(<ConnectorMarketplace />);

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }));
    const confirm = await screen.findAllByRole('button', { name: 'Uninstall' });
    fireEvent.click(confirm[confirm.length - 1]);

    expect(await screen.findByText('Forbidden resource')).toBeInTheDocument();
  });

  it('shows an error state with the reason, not the connectors, when GET /connectors failed', async () => {
    store.installed = [{ connectorName: 'okta' }];
    store.isInstalled = () => true;
    store.syncError = apiError(
      503,
      'The stored config of connector "okta" could not be decrypted by this process',
    );
    renderWithProviders(<ConnectorMarketplace />);

    expect(await screen.findByText('Could not load the installed connectors')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The stored config of connector "okta" could not be decrypted by this process',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Okta users and groups')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(store.syncFromBackend).toHaveBeenCalledTimes(2);
  });
});
