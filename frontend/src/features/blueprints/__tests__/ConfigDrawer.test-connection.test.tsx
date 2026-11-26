/**
 * Test Connection in the Design studio drawers. Only Active Directory's settings had one, and no
 * drawer called POST /connectors/:name/health-check, which answers for the HR sources and the
 * other targets too. Every connector whose manifest declares healthCheck now offers it where its
 * settings are edited; it checks the saved settings. Active Directory keeps its own, which tests
 * the form's values (ConnectorConfigTabs), and gets no second button.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { renderWithProviders } from '../../../test/test-utils';
import { ConfigDrawer } from '../ConfigDrawer';
import { buildNewConnector } from '../canvas';
import { getConnectorById } from '../shared';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));

vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: vi.fn(),
  },
}));

vi.mock('@api/constants', () => ({ API_BASE: '/api/v1' }));

/** What GET /connectors returned, by connector id. */
const SAVED: Record<string, Record<string, string>> = {
  okta: { orgUrl: 'https://example.okta.com', apiToken: '••••••••' },
  'csv-hr': { filePath: '/srv/hr/employees.csv' },
  ad: { host: 'dc01.corp.example' },
};

vi.mock('@stores/connector-store', () => ({
  useConnectorStore: () => ({
    getConfig: (name: string) =>
      SAVED[name] ? { connectorName: name, config: SAVED[name], installedAt: '' } : undefined,
    updateConfig: vi.fn().mockResolvedValue(undefined),
    syncFromBackend: () => Promise.resolve(),
    syncError: null,
  }),
}));

vi.mock('../brain-config', () => ({ BrainConfig: () => null }));

/** Every built-in connector declares healthCheck (backend/test/fixtures/connector-manifests.json). */
const MANIFESTS = ['okta', 'csv-hr', 'ad'].map((id) => ({
  id,
  name: id,
  capabilities: ['healthCheck'],
}));

function targetNode(connectorId: string): Node {
  const meta = getConnectorById(connectorId)!;
  const { node } = buildNewConnector(meta.name, 'target', meta.icon, []);
  return { ...node, data: { label: meta.name, role: 'target', type: connectorId } };
}

const csvSource: Node = {
  id: 'csv-hr-source',
  position: { x: 0, y: 0 },
  data: { label: 'CSV HR', role: 'source', type: 'csv-hr' },
};

function renderDrawer(node: Node) {
  renderWithProviders(
    <ConfigDrawer
      open
      onClose={vi.fn()}
      selectedNode={node}
      onDeleteConnector={vi.fn()}
      onUpdateNodeDataAndSave={vi.fn().mockResolvedValue(undefined)}
      activeConnectors={[]}
      activeConnectorsForMastery={[]}
      brainConfig={null}
      onCorrelationSave={vi.fn()}
    />,
  );
}

describe('ConfigDrawer Test Connection', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockImplementation(async (url: string) =>
      url === '/api/v1/connectors/available' ? { data: MANIFESTS } : { data: {} },
    );
  });

  it("checks an HR source's saved settings from its drawer", async () => {
    mockPost.mockResolvedValueOnce({
      data: { healthy: true, connected: true, message: 'The file has 42 rows' },
    });
    renderDrawer(csvSource);

    fireEvent.click(await screen.findByRole('button', { name: /Test Connection/ }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/connectors/csv-hr/health-check', {}),
    );
    expect(await screen.findByText('Connection healthy')).toBeInTheDocument();
  });

  it("checks a target's saved settings from its drawer and shows the failure", async () => {
    mockPost.mockResolvedValueOnce({
      data: { healthy: false, connected: false, error: 'Health check failed' },
    });
    renderDrawer(targetNode('okta'));
    await screen.findByDisplayValue('https://example.okta.com');

    fireEvent.click(screen.getByRole('button', { name: /Test Connection/ }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/connectors/okta/health-check', {}),
    );
    expect(await screen.findByText('Connection failed')).toBeInTheDocument();
  });

  it('gives Active Directory one Test Connection, its own', async () => {
    renderDrawer(targetNode('ad'));
    await screen.findByLabelText('Host / IP');

    expect(screen.getAllByRole('button', { name: /Test Connection/ })).toHaveLength(1);
    // The drawer's own check is not mounted: it would read the manifests first
    expect(mockGet).not.toHaveBeenCalledWith('/api/v1/connectors/available');
  });

  it('offers no check while the manifests say the connector has none', async () => {
    mockGet.mockImplementation(async (url: string) =>
      url === '/api/v1/connectors/available'
        ? { data: [{ id: 'okta', name: 'okta', capabilities: ['provision'] }] }
        : { data: {} },
    );
    renderDrawer(targetNode('okta'));
    await screen.findByDisplayValue('https://example.okta.com');
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/v1/connectors/available'));

    expect(screen.queryByRole('button', { name: /Test Connection/ })).not.toBeInTheDocument();
  });
});
