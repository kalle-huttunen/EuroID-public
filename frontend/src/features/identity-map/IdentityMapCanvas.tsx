/**
 * IdentityMapCanvas — main page for the Identity Entitlement Map.
 *
 * Composes useIdentityEntitlements + useEntitlementGraph hooks to render
 * a read-only ReactFlow canvas showing an identity's full entitlement landscape.
 */

import React, { useCallback, useContext, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  ReactFlowInstance,
} from '@xyflow/react';
import type { Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Button, Popover, Result, Space, Spin, Tag, Typography, theme } from 'antd';
import { AimOutlined, ArrowLeftOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { BRAND } from '@theme/themeConfig';
import { ColorModeContext } from '../../contexts/color-mode';
import { PageContainer } from '@shared/PageHeader';
import { backPath } from '../../utils/back-path';
import { useIdentityEntitlements } from './hooks/useIdentityEntitlements';
import { isSameTargetSystem, useEntitlementGraph } from './hooks/useEntitlementGraph';
import { nodeTypes, defaultEdgeOptions } from './canvas/nodes';
import { PolicyTraceModal } from './components/PolicyTraceModal';
import { DriftActionPanel } from './components/DriftActionPanel';
import type { EntitlementChipData } from './canvas/EntitlementChip';

const { Text } = Typography;

const legendContent = (
  <Space direction="vertical" size={4}>
    <Space size={8}>
      <div style={{ width: 24, height: 2, background: BRAND.edgeStroke }} />
      <Text style={{ fontSize: 12 }}>Provisioned</Text>
    </Space>
    <Space size={8}>
      <div
        style={{
          width: 24,
          height: 2,
          background: BRAND.primary,
          opacity: 0.6,
          borderTop: '2px dashed',
        }}
      />
      <Text style={{ fontSize: 12 }}>Granted, not yet provisioned</Text>
    </Space>
    <Space size={8}>
      <div
        style={{
          width: 24,
          height: 2,
          background: BRAND.edgeStroke,
          borderTop: '2px dashed',
        }}
      />
      <Text style={{ fontSize: 12 }}>Admin link</Text>
    </Space>
    <Space size={8}>
      <Tag color="success" style={{ margin: 0 }}>
        Synced
      </Tag>
      <Tag color="warning" style={{ margin: 0 }}>
        Drift
      </Tag>
      <Tag color="error" style={{ margin: 0 }}>
        Error
      </Tag>
    </Space>
  </Space>
);

export const IdentityMapCanvas: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Opened from an identity page, back returns there (with its tab); otherwise to the hub.
  const backTo = backPath(useLocation().state, '/users');
  const { token } = theme.useToken();
  const { mode } = useContext(ColorModeContext);
  const reactFlowRef = useRef<ReactFlowInstance | null>(null);

  // F-02 state
  const [selectedEntitlement, setSelectedEntitlement] = useState<{
    data: EntitlementChipData;
    nodeId: string;
  } | null>(null);

  // F-03 state
  const [selectedDriftTarget, setSelectedDriftTarget] = useState<string | null>(null);

  const { data, isLoading, isError } = useIdentityEntitlements(id ?? '');
  const { nodes, edges } = useEntitlementGraph(data);

  const handleFitView = useCallback(() => {
    reactFlowRef.current?.fitView({ padding: 0.2 });
  }, []);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.type === 'entitlementChip') {
      setSelectedEntitlement({
        data: node.data as unknown as EntitlementChipData,
        nodeId: node.id,
      });
    }
    if (node.type === 'targetSystemNode') {
      const systemData = node.data as { driftCount?: number; systemName?: string };
      if (systemData.driftCount && systemData.driftCount > 0) {
        setSelectedDriftTarget(systemData.systemName ?? null);
      }
    }
  }, []);

  const displayName =
    (data.identity?.displayName as string) ||
    `${data.identity?.firstName ?? ''} ${data.identity?.lastName ?? ''}`.trim() ||
    'Identity';

  if (!id) {
    return (
      <Result
        status="404"
        title="No identity selected"
        subTitle="Open an identity from the Identity hub to view its entitlement map."
        extra={
          <Button type="primary" onClick={() => navigate('/users')}>
            Go to Identity hub
          </Button>
        }
      />
    );
  }

  if (isError) {
    return (
      <Result
        status="error"
        title="Failed to load entitlement map"
        subTitle="Could not fetch identity data. Please try again."
        extra={
          <Button type="primary" onClick={() => window.location.reload()}>
            Retry
          </Button>
        }
      />
    );
  }

  return (
    <PageContainer fill>
      {/* Header */}
      <div
        style={{
          padding: '12px 24px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <Space size={12} align="center">
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate(backTo)}
            aria-label={backTo === '/users' ? 'Back to Identity hub' : 'Back to identity'}
          />
          <div>
            <Typography.Title level={4} style={{ margin: 0, fontWeight: 600 }}>
              {displayName}
            </Typography.Title>
            <Text type="secondary" style={{ fontSize: 13 }}>
              Entitlement map
            </Text>
            {/* The hub records access per identity only for what it grants. */}
            <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              Shows access granted by policies and access requests. Access assigned directly in a
              target system is not recorded per identity and is not shown.
            </Text>
          </div>
        </Space>
        <Space>
          <Button icon={<AimOutlined />} onClick={handleFitView}>
            Fit view
          </Button>
          <Popover content={legendContent} title="Legend" trigger="click">
            <Button icon={<InfoCircleOutlined />}>Legend</Button>
          </Popover>
        </Space>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {isLoading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: token.colorBgLayout,
              zIndex: 10,
            }}
            aria-busy
          >
            <Space direction="vertical" align="center" size={12}>
              <Spin />
              <Text type="secondary">Loading entitlement data</Text>
            </Space>
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          colorMode={mode}
          style={
            {
              background: token.colorBgLayout,
              // Canvas chrome from theme tokens, so dark mode matches the navy shell
              // instead of React Flow's neutral dark greys.
              '--xy-controls-button-background-color': token.colorBgContainer,
              '--xy-controls-button-background-color-hover': token.colorFillSecondary,
              '--xy-controls-button-color': token.colorText,
              '--xy-controls-button-color-hover': token.colorText,
              '--xy-controls-button-border-color': token.colorBorderSecondary,
            } as React.CSSProperties
          }
          onInit={(instance) => {
            reactFlowRef.current = instance;
            instance.fitView({ padding: 0.2 });
          }}
          onNodeClick={handleNodeClick}
          onPaneClick={() => {
            setSelectedEntitlement(null);
            setSelectedDriftTarget(null);
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          fitView
        >
          <Background
            variant={BackgroundVariant.Dots}
            color={token.colorBorder}
            bgColor={token.colorBgLayout}
            gap={18}
            size={1.5}
          />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* F-02: Policy Trace */}
      <PolicyTraceModal
        entitlement={selectedEntitlement?.data ?? null}
        policyIntent={data.policyIntent}
        open={!!selectedEntitlement}
        onClose={() => setSelectedEntitlement(null)}
      />

      {/* F-03: Drift Action Panel */}
      <DriftActionPanel
        targetSystem={selectedDriftTarget}
        drifts={
          selectedDriftTarget
            ? data.drifts.filter((d) => isSameTargetSystem(d.targetSystem, selectedDriftTarget))
            : []
        }
        identityId={id}
        open={!!selectedDriftTarget}
        onClose={() => setSelectedDriftTarget(null)}
      />
    </PageContainer>
  );
};
