import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReactFlow, MiniMap } from '@xyflow/react';
import type { NodeChange } from '@xyflow/react';
import { useCanvasNodeManagement } from '../useCanvasNodeManagement';
import { useCanvasEnrichedNodes } from '../useCanvasEnrichedNodes';
import type { CanvasPalette } from '../useCanvasEnrichedNodes';
import { ConditionNode, ActionNode } from '../../canvas';
import { usePolicyDraftStore } from '@stores/policy-draft-store';

// The canvas loads the installed connector list on mount; keep it off the network.
vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn().mockResolvedValue({ data: [] }) },
}));

const api = { success: vi.fn() } as unknown as Parameters<typeof useCanvasNodeManagement>[0]['api'];
const palette: CanvasPalette = {
  surface: 'white', border: 'gray', text: 'black', textSecondary: 'gray',
  primary: 'blue', primaryBg: 'lightblue', edge: 'gray', shadow: 'none',
};
const nodeTypes = { condition: ConditionNode, action: ActionNode };

type OnNodesChange = (changes: NodeChange[]) => void;

/** The Design studio's node pipeline: node management -> enrichment -> React Flow with its MiniMap. */
function Canvas({ exposeOnNodesChange }: { exposeOnNodesChange: (fn: OnNodesChange) => void }) {
  const mgmt = useCanvasNodeManagement({ api, reactFlowRef: { current: null } });
  const { allNodes, allEdges } = useCanvasEnrichedNodes({
    nodes: mgmt.nodes,
    edges: mgmt.edges,
    sourceCounts: {},
    connectorHealth: {},
    draftNodes: mgmt.draftNodes,
    draftEdges: mgmt.draftEdges,
    draftNodeSizes: mgmt.draftNodeSizes,
    colorPrimary: 'blue',
    palette,
    live: false,
  });
  useEffect(() => exposeOnNodesChange(mgmt.onNodesChange), [exposeOnNodesChange, mgmt.onNodesChange]);
  return (
    <div style={{ width: 800, height: 600 }}>
      <ReactFlow nodes={allNodes} edges={allEdges} nodeTypes={nodeTypes} onNodesChange={mgmt.onNodesChange}>
        <MiniMap />
      </ReactFlow>
    </div>
  );
}

describe('policy draft nodes in the MiniMap', () => {
  beforeEach(() => {
    usePolicyDraftStore.setState({
      draftNodes: [
        { id: 'condition-1', type: 'condition', position: { x: 400, y: 400 }, data: { field: 'department', operator: 'equals', value: 'Sales' } },
        { id: 'action-1', type: 'action', position: { x: 700, y: 400 }, data: { targetSystem: 'entra-id', actionType: 'assign_group' } },
      ],
      draftEdges: [],
      isDirty: false,
    });
  });

  // jsdom has no layout, so the measurement React Flow reports in a browser is fed in by hand.
  it('draws condition and action nodes once React Flow has measured them, without dirtying the draft', () => {
    let onNodesChange: OnNodesChange = () => undefined;
    const { container } = render(
      <MemoryRouter>
        <Canvas exposeOnNodesChange={(fn) => { onNodesChange = fn; }} />
      </MemoryRouter>,
    );
    expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);

    act(() =>
      onNodesChange([
        { id: 'condition-1', type: 'dimensions', dimensions: { width: 200, height: 80 } },
        { id: 'action-1', type: 'dimensions', dimensions: { width: 180, height: 60 } },
      ]),
    );

    const minimapNodes = container.querySelectorAll('.react-flow__minimap-node');
    expect(minimapNodes).toHaveLength(2);
    expect([...minimapNodes].map((n) => n.getAttribute('width')).sort()).toEqual(['180', '200']);
    expect(usePolicyDraftStore.getState().isDirty).toBe(false);
  });
});
