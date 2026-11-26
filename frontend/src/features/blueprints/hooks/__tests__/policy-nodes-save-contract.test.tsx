/**
 * Contract of the Design studio's canvas save (POST /blueprints/save) with policy nodes.
 *
 * An admin adds a condition from the NodePalette by dragging it onto the canvas and an action
 * with the keyboard (Enter, added at the canvas center), fills in the condition, connects the
 * two and saves. The condition and action nodes and their edge go out with the connector graph,
 * whose edge flow conditions (30db3080) stay as loaded. The body is pinned in
 * backend/test/fixtures/blueprint-save-policy-nodes.payload.json, which the backend contract
 * test (blueprints-save-contract.spec.ts) saves and loads back. Reloading that body puts the
 * policy nodes back into the draft, clean.
 */
import React, { useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { useCanvasNodeManagement } from '../useCanvasNodeManagement';
import { useCanvasLoadAndSave } from '../useCanvasLoadAndSave';
import { NodePalette } from '../../NodePalette';
import { usePolicyDraftStore } from '@stores/policy-draft-store';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(resolve(__dirname, `../../../../../../backend/test/fixtures/${name}`), 'utf8'),
  );

/** The canvas loaded first: connector graph with flow conditions on the Brain -> Okta edge. */
const edgeConditionCanvas = fixture('blueprint-save-edge-conditions.payload.json');

/** Fixed clock: new nodes and edges are named after Date.now(). */
const NOW = Date.UTC(2026, 10, 22, 9, 0, 0);

/** React Flow's screen -> flow transform for a viewport panned by (100, 50) at zoom 1. */
const flow = {
  current: {
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x: x - 100, y: y - 50 }),
  },
};
/** Where the canvas sits on screen; its center is (740, 420). */
const CANVAS_RECT = {
  left: 240,
  top: 120,
  width: 1000,
  height: 600,
  right: 1240,
  bottom: 720,
  x: 240,
  y: 120,
};

const api = { success: vi.fn(), error: vi.fn(), warning: vi.fn() } as unknown as Parameters<
  typeof useCanvasLoadAndSave
>[0]['api'];

/** The Design studio's wiring (BlueprintCanvas): palette, drop target, connect, save. */
function DesignStudioPolicyNodes() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeMgmt = useCanvasNodeManagement({ api, reactFlowRef: flow, canvasRef });
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
      <div
        ref={(el) => {
          canvasRef.current = el;
          if (el) el.getBoundingClientRect = () => ({ ...CANVAS_RECT, toJSON: () => CANVAS_RECT });
        }}
        data-testid="canvas"
        onDrop={nodeMgmt.onDrop}
        onDragOver={nodeMgmt.onDragOver}
      />
      <NodePalette onAdd={nodeMgmt.addPolicyNodeAtCenter} />
      {/* React Flow calls onConnect when a handle is dragged to another node's handle. */}
      <button
        type="button"
        onClick={() =>
          nodeMgmt.onConnect({
            source: nodeMgmt.draftNodes.find((n) => n.type === 'condition')?.id ?? null,
            target: nodeMgmt.draftNodes.find((n) => n.type === 'action')?.id ?? null,
          })
        }
      >
        Connect condition to action
      </button>
      <button type="button" onClick={handleSaveCanvas}>
        Save canvas
      </button>
      <ul aria-label="connector nodes">
        {nodes.map((n) => (
          <li key={n.id}>{n.id}</li>
        ))}
      </ul>
      <ul aria-label="connector edges">
        {edges.map((e) => (
          <li key={e.id}>{e.id}</li>
        ))}
      </ul>
    </>
  );
}

/** What the browser hands the drop target when a palette item is dragged onto it. */
function dragOnto(item: HTMLElement, target: HTMLElement, x: number, y: number) {
  const store: Record<string, string> = {};
  const dataTransfer = {
    setData: (format: string, value: string) => {
      store[format] = value;
    },
    getData: (format: string) => store[format] ?? '',
    effectAllowed: 'all',
    dropEffect: 'none',
  };
  fireEvent.dragStart(item, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  const drop = createEvent.drop(target, { dataTransfer });
  Object.defineProperties(drop, { clientX: { value: x }, clientY: { value: y } });
  fireEvent(target, drop);
}

/** What goes over the wire: axios sends the body as JSON. */
const onTheWire = (body: unknown) => JSON.parse(JSON.stringify(body));

async function renderWith(canvas: unknown) {
  mockGet.mockImplementation(async (url: string) =>
    url.endsWith('/blueprints/latest')
      ? { data: { success: true, data: { ...(canvas as object), connectorConfigs: {} } } }
      : { data: [] },
  );
  const view = render(
    <MemoryRouter>
      <DesignStudioPolicyNodes />
    </MemoryRouter>,
  );
  await screen.findByText('Save canvas');
  return view;
}

describe('Design studio policy node save contract', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    usePolicyDraftStore.getState().reset();
    mockGet.mockReset();
    mockPost.mockReset().mockResolvedValue({ data: { success: true, nodeCount: 6 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds nodes by drag and by keyboard, and saving posts the pinned payload', async () => {
    await renderWith(edgeConditionCanvas);

    // Drag: the condition lands where it is dropped.
    dragOnto(
      screen.getByRole('button', { name: /Add condition: Department equals/ }),
      screen.getByTestId('canvas'),
      400,
      300,
    );
    // Keyboard: Enter adds the action at the center of the canvas, (640, 370), where the Entra ID
    // node (700..880 x 350..410) sits, so it goes straight below that node instead of onto it.
    const action = screen.getByRole('button', { name: /Add action: Assign Entra ID Group/ });
    action.focus();
    fireEvent.keyDown(action, { key: 'Enter' });

    const draft = () => usePolicyDraftStore.getState();
    expect(draft().draftNodes).toEqual([
      {
        id: `condition-${NOW}`,
        type: 'condition',
        position: { x: 300, y: 250 },
        data: { field: 'department', operator: 'equals', value: '' },
      },
      {
        id: `action-${NOW}`,
        type: 'action',
        position: { x: 640, y: 426 },
        data: { targetSystem: 'entra-id', actionType: 'assign_group' },
      },
    ]);
    expect(draft().isDirty).toBe(true);

    // The condition drawer saves its form through CanvasDrawers -> updateNode.
    act(() => {
      draft().updateNode(`condition-${NOW}`, {
        data: { field: 'department', operator: 'equals', value: 'Engineering' },
      });
    });
    await act(async () => screen.getByText('Connect condition to action').click());

    await act(async () => screen.getByText('Save canvas').click());
    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toMatch(/\/blueprints\/save$/);
    const sent = onTheWire(body);
    expect(sent.nodes.slice(-2).map((n: { id: string }) => n.id)).toEqual([
      `condition-${NOW}`,
      `action-${NOW}`,
    ]);
    expect(sent.edges.slice(-1)).toEqual([
      {
        id: `e-condition-${NOW}-action-${NOW}-${NOW}`,
        source: `condition-${NOW}`,
        target: `action-${NOW}`,
      },
    ]);
    // The connector graph and its edge flow conditions go out as loaded.
    expect(sent.nodes.slice(0, -2)).toEqual(edgeConditionCanvas.nodes);
    expect(sent.edges.slice(0, -1)).toEqual(edgeConditionCanvas.edges);
    expect(sent).toEqual(fixture('blueprint-save-policy-nodes.payload.json'));
    expect(draft().isDirty).toBe(false);
  });

  it('reloads the saved policy nodes into a clean draft, apart from the connector graph', async () => {
    usePolicyDraftStore.getState().addNode({
      id: 'condition-unsaved',
      type: 'condition',
      position: { x: 0, y: 0 },
      data: {},
    });
    const saved = fixture('blueprint-save-policy-nodes.payload.json');

    await renderWith(saved);

    const draft = usePolicyDraftStore.getState();
    expect(draft.draftNodes).toEqual(saved.nodes.slice(-2));
    expect(draft.draftEdges).toEqual(saved.edges.slice(-1));
    expect(draft.isDirty).toBe(false);
    const ids = (name: string) =>
      [...screen.getByRole('list', { name }).children].map((li) => li.textContent);
    expect(ids('connector nodes')).toEqual(
      edgeConditionCanvas.nodes.map((n: { id: string }) => n.id),
    );
    expect(ids('connector edges')).toEqual(
      edgeConditionCanvas.edges.map((e: { id: string }) => e.id),
    );
  });
});
