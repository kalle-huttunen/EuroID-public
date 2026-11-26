/**
 * The Brain node is the only way to Identity Correlation and field mastery (its drawer). React
 * Flow deletes a selected node on Backspace, and nothing added the Brain back, so a canvas saved
 * without it lost those settings in the UI. The canvas now hands React Flow every Brain as not
 * deletable (new or loaded; the flag stays out of the saved canvas), and a saved canvas without
 * a Brain gets it back on load.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Node } from '@xyflow/react';
import { useCanvasNodeManagement } from '../useCanvasNodeManagement';
import { useCanvasLoadAndSave } from '../useCanvasLoadAndSave';
import { useCanvasEnrichedNodes, type CanvasPalette } from '../useCanvasEnrichedNodes';
import { initialNodes } from '../../canvas';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: vi.fn(),
  },
}));

const api = { success: vi.fn(), error: vi.fn(), warning: vi.fn() } as unknown as Parameters<
  typeof useCanvasLoadAndSave
>[0]['api'];

const palette: CanvasPalette = {
  surface: 'var(--surface)',
  border: 'var(--border)',
  text: 'var(--text)',
  textSecondary: 'var(--text-secondary)',
  primary: 'var(--primary)',
  primaryBg: 'var(--primary-bg)',
  edge: 'var(--edge)',
  shadow: 'none',
};

/** What GET /blueprints/latest returns for a saved canvas: JSON, labels as `{ text, icon }`. */
const savedNode = (id: string, role: string, text: string, icon: string, x: number): Node => ({
  id,
  type: 'connectorNode',
  position: { x, y: 250 },
  data: { label: { text, icon }, role },
});
const savedSource = savedNode('csv-hr-source', 'source', 'CSV HR', 'FileTextOutlined', 50);
const savedBrain = savedNode('euroid-core', 'brain', 'EuroID Brain', 'RobotOutlined', 350);
const savedTarget = savedNode(
  'entra-target',
  'target',
  'Microsoft Entra ID',
  'SafetyCertificateOutlined',
  700,
);

/** The nodes as the canvas hands them to React Flow: label and whether React Flow may delete. */
function RenderedNodes({ nodes }: { nodes: Node[] }) {
  const { allNodes } = useCanvasEnrichedNodes({
    nodes,
    edges: [],
    sourceCounts: {},
    connectorHealth: {},
    draftNodes: [],
    draftEdges: [],
    draftNodeSizes: {},
    colorPrimary: 'var(--primary)',
    palette,
    live: false,
  });
  return (
    <ul aria-label="Canvas nodes">
      {allNodes.map((n) => (
        <li key={n.id} data-testid={n.id} data-deletable={String(n.deletable !== false)}>
          {n.data.label as React.ReactNode}
        </li>
      ))}
    </ul>
  );
}

/** The canvas state after loading the saved canvas, as the Design studio holds it. */
function LoadedCanvas() {
  const nodeMgmt = useCanvasNodeManagement({ api, reactFlowRef: { current: null } });
  const { nodes, setNodes, edges, setEdges } = nodeMgmt;
  const { isLoading } = useCanvasLoadAndSave({ setNodes, setEdges, nodes, edges, api });
  if (isLoading) return null;
  return <RenderedNodes nodes={nodes} />;
}

async function renderSaved(nodes: Node[]) {
  mockGet.mockImplementation(async (url: string) =>
    url.endsWith('/blueprints/latest')
      ? { data: { success: true, data: { nodes, edges: [], connectorConfigs: {} } } }
      : { data: [] },
  );
  render(
    <MemoryRouter>
      <LoadedCanvas />
    </MemoryRouter>,
  );
  return screen.findByRole('list', { name: 'Canvas nodes' });
}

describe('the Brain node', { timeout: 20_000 }, () => {
  // A block body: a function returned from beforeEach runs as a cleanup hook, which would call
  // the mock with no URL.
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('is not deletable on a new canvas; the connectors are', () => {
    render(<RenderedNodes nodes={initialNodes as Node[]} />);

    expect(screen.getByTestId('euroid-core')).toHaveAttribute('data-deletable', 'false');
    expect(screen.getByTestId('csv-hr-source')).toHaveAttribute('data-deletable', 'true');
    expect(screen.getByTestId('entra-target')).toHaveAttribute('data-deletable', 'true');
    // The flag lives where nodes reach React Flow, so the saved canvas never carries it.
    expect(initialNodes.every((n) => !('deletable' in n))).toBe(true);
  });

  it('is not deletable on a loaded canvas, which saved it without that flag', async () => {
    await renderSaved([savedSource, savedBrain, savedTarget]);

    expect(screen.getByTestId('euroid-core')).toHaveAttribute('data-deletable', 'false');
    expect(screen.getByTestId('euroid-core')).toHaveTextContent('EuroID Brain');
    expect(screen.getByTestId('csv-hr-source')).toHaveAttribute('data-deletable', 'true');
    expect(screen.getByTestId('entra-target')).toHaveAttribute('data-deletable', 'true');
  });

  it('comes back on load when the saved canvas has none', async () => {
    const list = await renderSaved([savedSource, savedTarget]);

    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.dataset.testid),
    ).toEqual(['csv-hr-source', 'entra-target', 'euroid-core']);
    const brain = screen.getByTestId('euroid-core');
    expect(brain).toHaveTextContent('EuroID Brain');
    expect(within(brain).getByRole('img', { name: 'robot' })).toBeInTheDocument();
    expect(brain).toHaveAttribute('data-deletable', 'false');
  });

  it('is not added twice when the saved Brain has another id', async () => {
    const list = await renderSaved([
      savedSource,
      savedNode('core', 'brain', 'EuroID Brain', 'RobotOutlined', 350),
      savedTarget,
    ]);

    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.dataset.testid),
    ).toEqual(['csv-hr-source', 'core', 'entra-target']);
    expect(screen.getByTestId('core')).toHaveAttribute('data-deletable', 'false');
  });
});
