import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { BlueprintCanvas } from '../BlueprintCanvas';
import { useConnectorStore } from '@stores/connector-store';

// Connectors installed in the backend (GET /connectors); the real store loads them.
const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
const INSTALLED = [
  { connectorName: 'csv-hr', config: {}, installedAt: '2026-11-01T00:00:00.000Z' },
  { connectorName: 'github', config: { orgName: 'acme', personalAccessToken: '••••••••' }, installedAt: '2026-11-01T00:00:00.000Z' },
];

vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args), post: vi.fn() },
}));
vi.mock('@api/realtime', () => ({ useRealTimeEvents: () => {} }));
vi.mock('@api/resource-hooks', () => ({
  useList: () => ({ data: { data: [] } }),
  useInvalidate: () => vi.fn(),
}));
vi.mock('../ImpactAnalysisModal', () => ({ ImpactAnalysisModal: () => null }));
vi.mock('../DeployModal', () => ({ DeployModal: () => null }));
vi.mock('../ConfigDrawer', () => ({ ConfigDrawer: () => null }));

const connectorListCalls = () => mockGet.mock.calls.filter(([url]) => url === '/api/v1/connectors');

async function openAddConnectorMenu() {
  fireEvent.mouseEnter(await screen.findByRole('button', { name: /add connector/i }));
}

describe('BlueprintCanvas "Add connector" menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A fresh browser: nothing persisted, nothing loaded in this page session.
    localStorage.clear();
    useConnectorStore.setState({ installed: [], syncedFromBackend: false });
    mockGet.mockImplementation(async (url: string) =>
      url === '/api/v1/connectors'
        ? { data: INSTALLED }
        : { data: { success: true, data: { nodes: [], edges: [] } } },
    );
  });

  it('lists the connectors installed in the backend without visiting the Marketplace first', async () => {
    renderWithProviders(<BlueprintCanvas />);
    await openAddConnectorMenu();

    expect(await screen.findByRole('menuitem', { name: /CSV HR/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /GitHub/ })).toBeInTheDocument();
    expect(screen.queryByText('Install from Connector Marketplace first')).not.toBeInTheDocument();
    expect(connectorListCalls()).toHaveLength(1);
  });

  it('does not fetch the list again when the Marketplace already loaded it in this session', async () => {
    await useConnectorStore.getState().syncFromBackend();
    mockGet.mockClear();

    renderWithProviders(<BlueprintCanvas />);
    await openAddConnectorMenu();

    expect(await screen.findByRole('menuitem', { name: /GitHub/ })).toBeInTheDocument();
    expect(connectorListCalls()).toHaveLength(0);
  });
});
