/**
 * Save Config in a Design studio HR source's drawer. With a required field empty it sent nothing
 * and showed nothing the admin could see (the button is in the drawer header, the fields far
 * below), and a source never saved from the drawer opened with an empty form although its
 * connector was installed with settings. Now the empty field shows its error, the drawer scrolls
 * to it and a message says why nothing was saved; and the form starts from the installed
 * connector's settings (GET /connectors) when the node has no saved config.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { renderWithProviders } from '../../../test/test-utils';
import { ConfigDrawer } from '../ConfigDrawer';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn(), patch: vi.fn() },
}));

/** The installed connectors' settings as GET /connectors returned them, by connector id. */
let installed: Record<string, Record<string, string>> = {};
const syncFromBackend = vi.fn(() => Promise.resolve());
vi.mock('@stores/connector-store', () => ({
  useConnectorStore: () => ({
    getConfig: (name: string) =>
      installed[name]
        ? { connectorName: name, config: installed[name], installedAt: '' }
        : undefined,
    updateConfig: vi.fn().mockResolvedValue(undefined),
    syncFromBackend,
    syncError: null,
  }),
}));

vi.mock('../brain-config', () => ({ BrainConfig: () => null }));

const csvSource = (config?: Record<string, unknown>): Node => ({
  id: 'csv-hr-source',
  position: { x: 0, y: 0 },
  data: { label: 'CSV HR', role: 'source', type: 'csv-hr', ...(config ? { config } : {}) },
});

function renderDrawer(node: Node) {
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  renderWithProviders(
    <ConfigDrawer
      open
      onClose={vi.fn()}
      selectedNode={node}
      onDeleteConnector={vi.fn()}
      onUpdateNodeDataAndSave={onUpdate}
      activeConnectors={[]}
      activeConnectorsForMastery={[]}
      brainConfig={null}
      onCorrelationSave={vi.fn()}
    />,
  );
  return onUpdate;
}

describe('ConfigDrawer HR source Save Config', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installed = {};
  });

  it("starts a source never saved from the drawer from its installed connector's settings", async () => {
    installed = { 'csv-hr': { filePath: '/srv/hr/employees.csv', sourceSystem: 'csv-hr-prod' } };
    renderDrawer(csvSource());

    await waitFor(() =>
      expect(screen.getByLabelText('File Path')).toHaveValue('/srv/hr/employees.csv'),
    );
    expect(syncFromBackend).toHaveBeenCalled();
    expect(screen.getByLabelText('Source System Name')).toHaveValue('csv-hr-prod');
    // The node's own Priority & Mastery defaults stay.
    expect(screen.getByLabelText('Primary')).toBeChecked();
  });

  it("keeps the node's own saved config over the connector's settings", async () => {
    installed = { 'csv-hr': { filePath: '/srv/hr/employees.csv' } };
    renderDrawer(csvSource({ filePath: '/data/hr.csv' }));

    expect(await screen.findByLabelText('File Path')).toHaveValue('/data/hr.csv');
  });

  it('with a required field empty, saves nothing and says why on the field and in a message', async () => {
    const onUpdate = renderDrawer(csvSource());
    await waitFor(() => expect(syncFromBackend).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    expect(await screen.findByText('File Path is required.')).toBeInTheDocument();
    expect(await screen.findByText('Not saved: File Path is required.')).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
