/**
 * Read-only React Flow canvas of an identity's access graph (layout in access-graph.ts): the
 * identity on the left, a column per hop. Dashed edges are group memberships; an edge label says
 * policy or request where the graph knows how the access was granted. Theme tokens only.
 */
import React, { useContext } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
} from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Typography, theme } from 'antd';
import { AppstoreOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { ColorModeContext } from '../../contexts/color-mode';
import type { CanvasLayout, GraphNodeData } from './access-graph';
import { entitlementDetail, identityText, TYPE_LABEL } from './access-explorer-labels';

const { Text } = Typography;

const ICON = {
  Identity: <UserOutlined />,
  Entitlement: <SafetyCertificateOutlined />,
  Application: <AppstoreOutlined />,
  Role: <SafetyCertificateOutlined />,
};

const GraphNodeCard: React.FC<NodeProps> = ({ data }) => {
  const { token } = theme.useToken();
  const { node, root } = data as GraphNodeData;
  const title = node.type === 'Identity' ? identityText(node) : node.label || node.id;
  const detail = node.type === 'Identity' ? undefined : entitlementDetail(node);
  return (
    <div
      role="group"
      aria-label={`${TYPE_LABEL[node.type]}: ${title}`}
      style={{
        width: 220,
        padding: '8px 12px',
        borderRadius: token.borderRadiusLG,
        background: token.colorBgContainer,
        border: `${root ? 2 : 1}px solid ${root ? token.colorPrimary : token.colorBorder}`,
        boxShadow: token.boxShadowTertiary,
      }}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
        <span style={{ color: root ? token.colorPrimary : token.colorTextSecondary }}>
          {ICON[node.type]}
        </span>
        <Text strong ellipsis={{ tooltip: title }} style={{ fontSize: 13 }}>
          {title}
        </Text>
      </div>
      {detail && (
        <Text type="secondary" ellipsis style={{ display: 'block', fontSize: 11 }}>
          {detail}
        </Text>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
};

const nodeTypes = { graphNode: GraphNodeCard };

export const AccessGraphCanvas: React.FC<{ layout: CanvasLayout; label: string }> = ({
  layout,
  label,
}) => {
  const { token } = theme.useToken();
  const { mode } = useContext(ColorModeContext);
  return (
    <div
      role="region"
      aria-label={label}
      style={{
        height: 460,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadiusLG,
        overflow: 'hidden',
      }}
    >
      <ReactFlow
        nodes={layout.nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={{ style: { stroke: token.colorTextTertiary, strokeWidth: 1.5 } }}
        colorMode={mode}
        style={
          {
            background: token.colorBgLayout,
            // Canvas chrome from theme tokens, as on the entitlement map
            '--xy-controls-button-background-color': token.colorBgContainer,
            '--xy-controls-button-background-color-hover': token.colorFillSecondary,
            '--xy-controls-button-color': token.colorText,
            '--xy-controls-button-color-hover': token.colorText,
            '--xy-controls-button-border-color': token.colorBorderSecondary,
          } as React.CSSProperties
        }
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
};
