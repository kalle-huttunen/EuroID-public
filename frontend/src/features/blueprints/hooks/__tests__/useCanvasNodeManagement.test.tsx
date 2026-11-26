import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Node, NodeChange } from '@xyflow/react';
import { useCanvasNodeManagement } from '../useCanvasNodeManagement';
import { usePolicyDraftStore } from '@stores/policy-draft-store';

// The canvas loads the installed connector list on mount; keep it off the network.
vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn().mockResolvedValue({ data: [] }) },
}));

const api = { success: vi.fn() } as unknown as Parameters<typeof useCanvasNodeManagement>[0]['api'];

const connectorNode: Node = {
  id: 'scim-2.0-(generic)-target-1',
  type: 'connectorNode',
  position: { x: 700, y: 150 },
  data: { role: 'target', type: 'scim' },
};

function setup() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter>{children}</MemoryRouter>
  );
  const hook = renderHook(() => useCanvasNodeManagement({ api, reactFlowRef: { current: null } }), {
    wrapper,
  });
  act(() => hook.result.current.setNodes([connectorNode]));
  return hook;
}

describe('useCanvasNodeManagement onNodesChange', () => {
  beforeEach(() => {
    usePolicyDraftStore.setState({
      draftNodes: [
        { id: 'condition-1', type: 'condition', position: { x: 400, y: 400 }, data: {} },
      ],
      draftEdges: [],
      isDirty: false,
    });
  });

  it('stores the measured size of an unsaved connector node so the MiniMap can draw it', () => {
    const { result } = setup();

    act(() =>
      result.current.onNodesChange([
        { id: connectorNode.id, type: 'dimensions', dimensions: { width: 180, height: 40 } },
      ]),
    );

    expect(result.current.nodes[0].measured).toEqual({ width: 180, height: 40 });
  });

  it("keeps a policy node's measured size outside the draft, so the draft stays clean", () => {
    const { result } = setup();

    act(() =>
      result.current.onNodesChange([
        { id: 'condition-1', type: 'dimensions', dimensions: { width: 200, height: 80 } },
      ]),
    );

    expect(result.current.draftNodeSizes).toEqual({ 'condition-1': { width: 200, height: 80 } });
    expect(usePolicyDraftStore.getState().isDirty).toBe(false);
    expect(usePolicyDraftStore.getState().draftNodes[0]).not.toHaveProperty('measured');
    expect(result.current.nodes).toEqual([connectorNode]);
  });

  it('still routes a policy node move to the draft and marks it dirty', () => {
    const { result } = setup();

    act(() =>
      result.current.onNodesChange([
        { id: 'condition-1', type: 'position', position: { x: 10, y: 20 } } as NodeChange,
      ]),
    );

    expect(usePolicyDraftStore.getState().draftNodes[0].position).toEqual({ x: 10, y: 20 });
    expect(usePolicyDraftStore.getState().isDirty).toBe(true);
  });

  it('leaves connector nodes untouched on a selection-only change', () => {
    const { result } = setup();
    const before = result.current.nodes;

    act(() =>
      result.current.onNodesChange([{ id: connectorNode.id, type: 'select', selected: true }]),
    );

    expect(result.current.nodes).toBe(before);
  });
});

describe('useCanvasNodeManagement click-to-add', () => {
  // The Brain sits at the center of the visible canvas, where click-to-add aims (plan 2.0co).
  const brain: Node = {
    id: 'euroid-core',
    type: 'connectorNode',
    position: { x: 350, y: 250 },
    measured: { width: 190, height: 60 },
    data: { role: 'brain' },
  };
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 580 }) };

  beforeEach(() => {
    usePolicyDraftStore.setState({ draftNodes: [], draftEdges: [], isDirty: false });
  });

  it('places a new action below the Brain instead of on top of it', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <MemoryRouter>{children}</MemoryRouter>
    );
    const { result } = renderHook(
      () =>
        useCanvasNodeManagement({
          api,
          reactFlowRef: { current: { screenToFlowPosition: (p) => p } },
          canvasRef: { current: canvas as unknown as HTMLElement },
        }),
      { wrapper },
    );
    act(() => result.current.setNodes([brain]));

    act(() =>
      result.current.addPolicyNodeAtCenter({
        type: 'action',
        data: { targetSystem: 'ad', actionType: 'assign_group' },
      }),
    );

    const [added] = usePolicyDraftStore.getState().draftNodes;
    // Aimed at the center (400, 290), inside the Brain's box (350..540, 250..310).
    expect(added.position.x).toBe(400);
    expect(added.position.y).toBeGreaterThanOrEqual(brain.position.y + 60);
  });
});
