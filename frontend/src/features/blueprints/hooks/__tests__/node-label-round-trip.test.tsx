/**
 * Connector node labels survive save and reload with their icons.
 *
 * A label is a React element on the canvas (canvas/nodes.tsx, useConnectorActions). The canvas
 * save used to post it as is, JSON reduced it to `{ props: { children: [{ type: {} }, " CSV HR"] } }`
 * and the reload showed the name without its icon. The save now sends `{ text, icon }`, and
 * canvases saved in the old shape get their icons back from the node's connector.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Space } from 'antd';
import type { Node } from '@xyflow/react';
import { useCanvasNodeManagement } from '../useCanvasNodeManagement';
import { useCanvasLoadAndSave } from '../useCanvasLoadAndSave';
import { initialNodes, initialEdges, targetStyle } from '../../canvas';
import { getConnectorIcon } from '../../shared';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const api = { success: vi.fn(), error: vi.fn(), warning: vi.fn() } as unknown as Parameters<
  typeof useCanvasLoadAndSave
>[0]['api'];

/** What goes over the wire: axios sends the body as JSON. */
const onTheWire = <T,>(body: T): T => JSON.parse(JSON.stringify(body));

/** A GitHub target as "Add connector" creates it (useConnectorActions.handleAddSystem). */
const githubNode: Node = {
  id: 'github-target-1732262400000',
  type: 'connectorNode',
  position: { x: 700, y: 350 },
  style: targetStyle,
  data: {
    label: (
      <Space>
        {getConnectorIcon('GitHub')} {'GitHub'}
      </Space>
    ),
    role: 'target',
    type: 'github',
  },
};
const canvasNodes = [...initialNodes, githubNode] as Node[];

/** Icon (antd's aria-label) and name each node shows. */
const EXPECTED: Record<string, { icon: string; text: string }> = {
  'csv-hr-source': { icon: 'file-text', text: 'CSV HR' },
  'euroid-core': { icon: 'robot', text: 'EuroID Brain' },
  'entra-target': { icon: 'safety-certificate', text: 'Microsoft Entra ID' },
  'github-target-1732262400000': { icon: 'github', text: 'GitHub' },
};

function LabelsHarness() {
  const nodeMgmt = useCanvasNodeManagement({ api, reactFlowRef: { current: null } });
  const { nodes, setNodes, edges, setEdges } = nodeMgmt;
  const { handleSaveCanvas, isLoading } = useCanvasLoadAndSave({
    setNodes,
    setEdges,
    nodes,
    edges,
    api,
  });
  if (isLoading) return null;
  return (
    <>
      {nodes.map((n) => (
        <div key={n.id} data-testid={n.id}>
          {n.data.label as React.ReactNode}
        </div>
      ))}
      <button type="button" onClick={handleSaveCanvas}>
        Save canvas
      </button>
    </>
  );
}

async function renderLoaded(canvas: { nodes: unknown[]; edges: unknown[] }) {
  mockGet.mockImplementation(async (url: string) =>
    url.endsWith('/blueprints/latest')
      ? { data: { success: true, data: { ...canvas, connectorConfigs: {} } } }
      : { data: [] },
  );
  const view = render(
    <MemoryRouter>
      <LabelsHarness />
    </MemoryRouter>,
  );
  await screen.findByText('Save canvas');
  return view;
}

function expectLabelsWithIcons() {
  for (const [id, { icon, text }] of Object.entries(EXPECTED)) {
    const label = screen.getByTestId(id);
    expect(within(label).getByRole('img', { name: icon })).toBeInTheDocument();
    expect(label).toHaveTextContent(new RegExp(`^${text}$`));
  }
}

describe('canvas node labels across save and reload', { timeout: 20_000 }, () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset().mockResolvedValue({ data: { success: true, nodeCount: 4 } });
  });

  it('saves each label as text and icon key, and reloads it with its icon', async () => {
    // The canvas the old save stored: the element labels as JSON made them.
    const legacy = onTheWire({ nodes: canvasNodes, edges: initialEdges });
    expect(legacy.nodes[0].data.label).toMatchObject({
      props: { children: [{ type: {} }, ' CSV HR'] },
    });
    const first = await renderLoaded(legacy);
    expectLabelsWithIcons();

    await act(async () => screen.getByText('Save canvas').click());
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const saved = onTheWire(mockPost.mock.calls[0][1]) as { nodes: Node[]; edges: unknown[] };
    expect(Object.fromEntries(saved.nodes.map((n) => [n.id, n.data.label]))).toEqual({
      'csv-hr-source': { text: 'CSV HR', icon: 'FileTextOutlined' },
      'euroid-core': { text: 'EuroID Brain', icon: 'RobotOutlined' },
      'entra-target': { text: 'Microsoft Entra ID', icon: 'SafetyCertificateOutlined' },
      'github-target-1732262400000': { text: 'GitHub', icon: 'GithubOutlined' },
    });
    first.unmount();

    await renderLoaded(saved);
    expectLabelsWithIcons();
  });

  it('keeps plain text labels as text', async () => {
    await renderLoaded({
      nodes: [
        {
          id: 'csv-hr-source',
          type: 'connectorNode',
          position: { x: 0, y: 0 },
          data: { label: 'CSV HR', role: 'source', type: 'csv-hr' },
        },
        // A saved canvas without its Brain gets it back on load (withBrainNode)
        {
          id: 'euroid-core',
          type: 'connectorNode',
          position: { x: 0, y: 0 },
          data: { label: 'EuroID Brain', role: 'brain' },
        },
        {
          id: 'okta-target',
          type: 'connectorNode',
          position: { x: 0, y: 0 },
          data: { label: { text: 'Okta', icon: 'NoSuchIcon' }, role: 'target' },
        },
      ],
      edges: [],
    });

    expect(screen.getByTestId('csv-hr-source')).toHaveTextContent(/^CSV HR$/);
    expect(within(screen.getByTestId('csv-hr-source')).queryByRole('img')).toBeNull();
    expect(screen.getByTestId('okta-target')).toHaveTextContent(/^Okta$/);
    expect(within(screen.getByTestId('okta-target')).queryByRole('img')).toBeNull();

    await act(async () => screen.getByText('Save canvas').click());
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const saved = onTheWire(mockPost.mock.calls[0][1]) as { nodes: Node[] };
    expect(saved.nodes.map((n) => n.data.label)).toEqual(['CSV HR', 'EuroID Brain', 'Okta']);
  });

  it('shows the name of an old-shape label whose connector it cannot tell, without an icon', async () => {
    const unknown = onTheWire({
      id: 'legacy-node',
      type: 'connectorNode',
      position: { x: 0, y: 0 },
      data: {
        label: (
          <Space>
            {getConnectorIcon('Workday')} {'Workday'}
          </Space>
        ),
        role: 'source',
      },
    });

    await renderLoaded({ nodes: [unknown], edges: [] });

    expect(screen.getByTestId('legacy-node')).toHaveTextContent(/^Workday$/);
    expect(within(screen.getByTestId('legacy-node')).queryByRole('img')).toBeNull();
  });
});
