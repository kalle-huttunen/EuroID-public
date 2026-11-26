/**
 * The Design studio mounts the policy node rail (NodePalette) on its canvas: admins add
 * condition and action nodes by dragging them onto the canvas, or by click / Enter, and the
 * canvas save sends them. Before, the palette was never rendered and no policy node could be added.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '../../../test/test-utils';
import { BlueprintCanvas } from '../BlueprintCanvas';
import { usePolicyDraftStore } from '@stores/policy-draft-store';
import { DEFAULT_NODE_SIZE } from '../utils/free-position';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));
vi.mock('@api/realtime', () => ({ useRealTimeEvents: () => {} }));
vi.mock('@api/resource-hooks', () => ({
  useList: () => ({ data: { data: [] } }),
  useInvalidate: () => vi.fn(),
}));
vi.mock('../ImpactAnalysisModal', () => ({ ImpactAnalysisModal: () => null }));
vi.mock('../DeployModal', () => ({ DeployModal: () => null }));
vi.mock('../ConfigDrawer', () => ({ ConfigDrawer: () => null }));

const CANVAS = {
  nodes: [
    {
      id: 'csv-hr-source',
      type: 'connectorNode',
      position: { x: 50, y: 250 },
      data: { label: { text: 'CSV HR', icon: 'FileTextOutlined' }, role: 'source', type: 'csv-hr' },
    },
    {
      id: 'euroid-core',
      type: 'connectorNode',
      position: { x: 350, y: 250 },
      data: { label: { text: 'EuroID Brain', icon: 'RobotOutlined' }, role: 'brain' },
    },
  ],
  edges: [{ id: 'e1-core', source: 'csv-hr-source', target: 'euroid-core', label: 'HR Feed' }],
  connectorConfigs: {},
};

const policyNodes = (container: HTMLElement) =>
  container.querySelectorAll('.react-flow__node-condition, .react-flow__node-action');

function dropOnCanvas(container: HTMLElement, item: HTMLElement) {
  const store: Record<string, string> = {};
  const dataTransfer = {
    setData: (format: string, value: string) => {
      store[format] = value;
    },
    getData: (format: string) => store[format] ?? '',
    effectAllowed: 'all',
    dropEffect: 'none',
  };
  const pane = container.querySelector('.react-flow__pane') as HTMLElement;
  fireEvent.dragStart(item, { dataTransfer });
  fireEvent.dragOver(pane, { dataTransfer });
  const drop = createEvent.drop(pane, { dataTransfer });
  Object.defineProperties(drop, { clientX: { value: 320 }, clientY: { value: 180 } });
  fireEvent(pane, drop);
}

async function renderCanvas() {
  const view = renderWithProviders(<BlueprintCanvas />);
  const rail = await screen.findByRole('region', { name: 'Policy nodes' });
  await waitFor(() => expect(view.container.querySelectorAll('.react-flow__node')).toHaveLength(2));
  // The saved canvas is drawn: its connector nodes show their saved names.
  expect(screen.getByRole('application', { name: /policy builder canvas/i })).toBeInTheDocument();
  expect(screen.getByText('CSV HR')).toBeInTheDocument();
  expect(screen.getByText('EuroID Brain')).toBeInTheDocument();
  return { container: view.container, rail };
}

describe('BlueprintCanvas policy node rail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePolicyDraftStore.getState().reset();
    mockGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/blueprints/latest')) return { data: { success: true, data: CANVAS } };
      if (url.endsWith('/blueprints/pipeline-status')) return { data: { status: 'DRAFT' } };
      return { data: [] };
    });
    mockPost.mockResolvedValue({ data: { success: true, nodeCount: 4 } });
  });

  it('shows the condition and action items on the canvas', async () => {
    const { rail } = await renderCanvas();

    const conditions = within(within(rail).getByRole('list', { name: 'Conditions' })).getAllByRole(
      'button',
    );
    const actions = within(within(rail).getByRole('list', { name: 'Actions' })).getAllByRole(
      'button',
    );
    expect(conditions.map((b) => b.textContent)).toContain('Department equals...');
    expect(actions.map((b) => b.textContent)).toContain('Assign Entra ID Group');
    expect(conditions.every((b) => b.getAttribute('draggable') === 'true')).toBe(true);
    expect(conditions.every((b) => b.tabIndex === 0)).toBe(true);
  });

  it('adds a condition node where a palette item is dropped', async () => {
    const { container, rail } = await renderCanvas();

    dropOnCanvas(container, within(rail).getByRole('button', { name: /Department equals/ }));

    await waitFor(() => expect(policyNodes(container)).toHaveLength(1));
    expect(container.querySelector('.react-flow__node-condition')).toHaveTextContent(
      'department equals',
    );
    expect(usePolicyDraftStore.getState().draftNodes).toEqual([
      expect.objectContaining({
        type: 'condition',
        data: { field: 'department', operator: 'equals', value: '' },
      }),
    ]);
  });

  it('adds action nodes with a click and with Enter, without stacking them on one spot', async () => {
    const { container, rail } = await renderCanvas();

    fireEvent.click(within(rail).getByRole('button', { name: /Assign AD Group/ }));
    const notify = within(rail).getByRole('button', { name: /Send Notification/ });
    notify.focus();
    fireEvent.keyDown(notify, { key: 'Enter' });

    await waitFor(() => expect(policyNodes(container)).toHaveLength(2));
    const [first, second] = usePolicyDraftStore.getState().draftNodes;
    expect([first.data.actionType, second.data.actionType]).toEqual([
      'assign_group',
      'send_notification',
    ]);
    // The second goes straight below the first instead of on top of it.
    expect(second.position.x).toBe(first.position.x);
    expect(second.position.y).toBeGreaterThanOrEqual(first.position.y + DEFAULT_NODE_SIZE.height);
    expect(within(rail).getByText(/Added action "Send Notification"/)).toBeInTheDocument();
  });

  it('collapses and expands the rail', async () => {
    const { rail } = await renderCanvas();

    fireEvent.click(within(rail).getByRole('button', { name: 'Hide policy nodes' }));
    expect(within(rail).queryByRole('button', { name: /Department equals/ })).toBeNull();
    fireEvent.click(within(rail).getByRole('button', { name: 'Show policy nodes' }));
    expect(within(rail).getByRole('button', { name: /Department equals/ })).toBeInTheDocument();
  });

  it('saves the added nodes with the canvas', async () => {
    const { container, rail } = await renderCanvas();
    dropOnCanvas(container, within(rail).getByRole('button', { name: /Location equals/ }));
    fireEvent.click(within(rail).getByRole('button', { name: /Assign SCIM Resource/ }));
    await waitFor(() => expect(policyNodes(container)).toHaveLength(2));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByRole('button', { name: /save/i })));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/v1/blueprints/save', expect.anything()),
    );
    const body = mockPost.mock.calls.find(([url]) => url === '/api/v1/blueprints/save')?.[1];
    expect(body.nodes.map((n: { id: string; type: string }) => n.type)).toEqual([
      'connectorNode',
      'connectorNode',
      'condition',
      'action',
    ]);
    expect(body.nodes[2].data).toEqual({ field: 'location', operator: 'equals', value: '' });
    expect(body.nodes[3].data).toEqual({ targetSystem: 'scim', actionType: 'assign_group' });
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull());
  });
});
