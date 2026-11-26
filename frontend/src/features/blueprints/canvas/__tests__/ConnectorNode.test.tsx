import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import { ConnectorNode } from '../ConnectorNode';

const nodeTypes = { connectorNode: ConnectorNode };

describe('ConnectorNode', () => {
  it('renders connector name and type', () => {
    render(
      <ReactFlow
        nodes={[
          {
            id: 'n1',
            type: 'connectorNode',
            data: { label: 'Workday HR', role: 'source' },
            position: { x: 0, y: 0 },
          },
        ]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        panOnDrag={false}
      />
    );
    expect(screen.getByText('Workday HR')).toBeInTheDocument();
  });

  it('shows connected status for target with healthStatus online', () => {
    const { container } = render(
      <ReactFlow
        nodes={[
          {
            id: 'n1',
            type: 'connectorNode',
            data: { label: 'Entra ID', role: 'target', healthStatus: 'online' },
            position: { x: 0, y: 0 },
          },
        ]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        panOnDrag={false}
      />
    );
    expect(screen.getByText('Entra ID')).toBeInTheDocument();
    const node = container.querySelector('[data-testid="rf__node-n1"]');
    expect(node).toBeInTheDocument();
    const statusDot = node?.querySelector('[style*="border-radius: 50%"]');
    expect(statusDot).toBeInTheDocument();
    expect((statusDot as HTMLElement)?.style.background).toContain('196, 26'); // green for online
  });

  it('shows disconnected status for target with healthStatus offline', () => {
    const { container } = render(
      <ReactFlow
        nodes={[
          {
            id: 'n1',
            type: 'connectorNode',
            data: { label: 'Salesforce', role: 'target', healthStatus: 'offline' },
            position: { x: 0, y: 0 },
          },
        ]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        panOnDrag={false}
      />
    );
    expect(screen.getByText('Salesforce')).toBeInTheDocument();
    const node = container.querySelector('[data-testid="rf__node-n1"]');
    expect(node).toBeInTheDocument();
    const statusDot = node?.querySelector('[style*="border-radius: 50%"]');
    expect(statusDot).toBeInTheDocument();
    expect((statusDot as HTMLElement)?.style.background).toContain('255, 77, 79'); // red for offline
  });

  it('handles missing optional props gracefully', () => {
    render(
      <ReactFlow
        nodes={[
          {
            id: 'n1',
            type: 'connectorNode',
            data: { label: 'Test', role: 'brain' },
            position: { x: 0, y: 0 },
          },
        ]}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        panOnDrag={false}
      />
    );
    expect(screen.getByText('Test')).toBeInTheDocument();
  });
});
