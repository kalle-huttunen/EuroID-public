import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import { ActionNode } from '../ActionNode';
import { usePolicyDraftStore } from '@stores/policy-draft-store';

const nodeTypes = { action: ActionNode };

describe('ActionNode', () => {
  beforeEach(() => {
    usePolicyDraftStore.getState().reset();
  });

  it('renders action label (target system, action type)', () => {
    render(
      <ReactFlow
        nodes={[
          {
            id: 'a1',
            type: 'action',
            data: { targetSystem: 'entra-id', actionType: 'assign_group' },
            position: { x: 0, y: 0 },
          },
        ]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        panOnDrag={false}
      />,
    );
    expect(screen.getByText('Microsoft Entra ID')).toBeInTheDocument();
    expect(screen.getByText('Assign Entra ID Group')).toBeInTheDocument();
  });

  it('names an AD action node by the registry, not by the raw id ad', () => {
    render(
      <ReactFlow
        nodes={[
          {
            id: 'a2',
            type: 'action',
            data: { targetSystem: 'ad', actionType: 'assign_group' },
            position: { x: 0, y: 0 },
          },
        ]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        panOnDrag={false}
      />,
    );
    expect(screen.getByText('Active Directory')).toBeInTheDocument();
    expect(screen.getByText('Assign AD Group')).toBeInTheDocument();
    expect(screen.queryByText('ad')).not.toBeInTheDocument();
  });

  it('labels an action on all systems', () => {
    render(
      <ReactFlow
        nodes={[
          {
            id: 'a3',
            type: 'action',
            data: { targetSystem: 'all', actionType: 'remove_access' },
            position: { x: 0, y: 0 },
          },
        ]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        panOnDrag={false}
      />,
    );
    expect(screen.getByText('All Systems')).toBeInTheDocument();
    expect(screen.getByText('Remove Access')).toBeInTheDocument();
  });

  it('shows red border when validation errors exist', () => {
    usePolicyDraftStore.setState({
      validationErrors: [
        { nodeId: 'a1', field: 'targetSystem', message: 'Target system is required' },
      ],
    });
    const { container } = render(
      <ReactFlow
        nodes={[
          {
            id: 'a1',
            type: 'action',
            data: { targetSystem: 'entra-id', actionType: 'assign_group' },
            position: { x: 0, y: 0 },
          },
        ]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        panOnDrag={false}
      />,
    );
    const node = container.querySelector('[aria-invalid="true"]');
    expect(node).toBeInTheDocument();
    expect(node).toHaveStyle({ borderWidth: '2px' });
  });

  it('shows error tooltip', () => {
    usePolicyDraftStore.setState({
      validationErrors: [
        { nodeId: 'a1', field: 'targetSystem', message: 'Target system is required' },
      ],
    });
    const { container } = render(
      <ReactFlow
        nodes={[
          {
            id: 'a1',
            type: 'action',
            data: { targetSystem: '', actionType: '' },
            position: { x: 0, y: 0 },
          },
        ]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        panOnDrag={false}
      />,
    );
    const nodeWithError = container.querySelector('[aria-invalid="true"]');
    expect(nodeWithError).toBeInTheDocument();
    expect(container.querySelector('#action-node-error-a1')).toBeInTheDocument();
  });
});
