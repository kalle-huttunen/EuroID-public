/**
 * A Design studio HR source's Priority & Mastery settings. Two HR sources both tagged Primary
 * give every identity the same primary HR source (the backend breaks the tie by the ingest
 * priority, then the Recon Config source priority order, then the source name), which the admin
 * should choose instead: the drawer warns while another source on the canvas is also Primary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { renderWithProviders } from '../../../test/test-utils';
import { ConfigDrawer } from '../ConfigDrawer';
import { otherPrimarySources } from '../canvas';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn().mockResolvedValue({ data: {} }), post: vi.fn(), patch: vi.fn() },
}));

vi.mock('@stores/connector-store', () => ({
  useConnectorStore: () => ({
    getConfig: () => undefined,
    updateConfig: vi.fn(),
    syncFromBackend: () => Promise.resolve(),
  }),
}));

vi.mock('../brain-config', () => ({ BrainConfig: () => null }));

const source = (id: string, label: string, config?: Record<string, unknown>): Node => ({
  id,
  position: { x: 0, y: 0 },
  data: { label, role: 'source', type: id.replace(/-source$/, ''), ...(config ? { config } : {}) },
});

function renderDrawer(node: Node, others: string[]) {
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
      otherPrimarySources={others}
    />,
  );
  return onUpdate;
}

const WARNING = /JSON API HR is also tagged Primary/;

describe('ConfigDrawer HR source priority', { timeout: 20_000 }, () => {
  beforeEach(() => vi.clearAllMocks());

  it('warns while another HR source on the canvas is also Primary', async () => {
    renderDrawer(source('csv-hr-source', 'CSV HR'), ['JSON API HR']);

    expect(await screen.findByText(WARNING)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Secondary'));

    await waitFor(() => expect(screen.queryByText(WARNING)).not.toBeInTheDocument());
  });

  it('does not warn when this is the only Primary HR source', async () => {
    renderDrawer(source('csv-hr-source', 'CSV HR'), []);

    expect(await screen.findByLabelText('Primary')).toBeChecked();
    expect(screen.queryByText(/is also tagged Primary/)).not.toBeInTheDocument();
  });

  it('saves the contract tag and ingest priority with the source node', async () => {
    const onUpdate = renderDrawer(
      source('csv-hr-source', 'CSV HR', {
        filePath: '/data/hr.csv',
        contractTag: 'SECONDARY',
        ingestPriority: 2,
      }),
      [],
    );
    expect(await screen.findByLabelText('Secondary')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Save Config' }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(onUpdate.mock.calls[0][1].config).toEqual(
      expect.objectContaining({ contractTag: 'SECONDARY', ingestPriority: 2 }),
    );
  });
});

describe('otherPrimarySources', () => {
  it('lists the other HR sources whose saved contract tag is Primary', () => {
    const nodes: Node[] = [
      source('csv-hr-source', 'CSV HR', { contractTag: 'PRIMARY' }),
      source('json-api-hr-source', 'JSON API HR', { contractTag: 'PRIMARY' }),
      source('workday-source', 'Workday', { contractTag: 'SECONDARY' }),
      // Never configured: the backend reads no contract tag for it
      source('bamboohr-source', 'BambooHR'),
      {
        id: 'okta-target',
        position: { x: 0, y: 0 },
        data: { label: 'Okta', role: 'target', config: { contractTag: 'PRIMARY' } },
      },
    ];

    expect(otherPrimarySources(nodes, 'csv-hr-source')).toEqual(['JSON API HR']);
    expect(otherPrimarySources(nodes, 'workday-source')).toEqual(['CSV HR', 'JSON API HR']);
  });
});
