import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import { ConditionNode } from '../ConditionNode';
import { usePolicyDraftStore } from '@stores/policy-draft-store';

const nodeTypes = { condition: ConditionNode };

describe('ConditionNode', () => {
  beforeEach(() => {
    usePolicyDraftStore.getState().reset();
  });

  it('renders condition label (field, operator, value)', () => {
    render(
      <ReactFlow
        nodes={[
          {
            id: 'c1',
            type: 'condition',
            data: { field: 'department', operator: 'equals', value: 'Sales' },
            position: { x: 0, y: 0 },
          },
        ]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        panOnDrag={false}
      />,
    );
    expect(screen.getByText('department equals')).toBeInTheDocument();
    expect(screen.getByText('Sales')).toBeInTheDocument();
  });

  it('shows red border when validation errors exist for this node', () => {
    usePolicyDraftStore.setState({
      validationErrors: [{ nodeId: 'c1', field: 'field', message: 'Condition field is required' }],
    });
    const { container } = render(
      <ReactFlow
        nodes={[
          {
            id: 'c1',
            type: 'condition',
            data: { field: 'dept', operator: 'equals', value: 'A' },
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

  it('shows error tooltip with validation message', () => {
    usePolicyDraftStore.setState({
      validationErrors: [
        { nodeId: 'c1', field: 'field', message: 'Condition field is required' },
        { nodeId: 'c1', field: 'value', message: 'Value is required' },
      ],
    });
    const { container } = render(
      <ReactFlow
        nodes={[
          {
            id: 'c1',
            type: 'condition',
            data: { field: '', operator: 'equals', value: '' },
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
    expect(container.querySelector('#condition-node-error-c1')).toBeInTheDocument();
  });
});
