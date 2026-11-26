/**
 * BlueprintCanvas.tsx
 *
 * Interactive ReactFlow canvas for the EuroID integration architecture.
 * Composes useCanvasNodeManagement, useCanvasSimulation, useCanvasLoadAndSave,
 * useCanvasDeploy, useCanvasEnrichedNodes, CanvasToolbar, CanvasDrawers, and the
 * NodePalette rail for policy condition and action nodes.
 */
import React, { useState, useEffect, useRef, useContext, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Space, Spin, Alert, Button, Typography, notification, theme } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { POLL_INTERVALS } from '@config/polling';

import {
  initialNodes,
  initialEdges,
  detectActiveConnectors,
  deriveActiveConnectorsForMastery,
  otherPrimarySources,
  countUsersPerSource,
  ConnectorNode,
  ConditionNode,
  ActionNode,
} from './canvas';
import type { HealthStatus } from './canvas';
import type { PipelineConfig } from './DeployModal';
import { usePolicyDraftStore } from '@stores/policy-draft-store';
import { useCanvasNodeManagement } from './hooks/useCanvasNodeManagement';
import { useCanvasSimulation } from './hooks/useCanvasSimulation';
import { useCanvasLoadAndSave } from './hooks/useCanvasLoadAndSave';
import { useCanvasDeploy } from './hooks/useCanvasDeploy';
import { useCanvasEnrichedNodes } from './hooks/useCanvasEnrichedNodes';
import { CanvasToolbar } from './components/CanvasToolbar';
import { CanvasDrawers } from './components/CanvasDrawers';
import { NodePalette } from './NodePalette';
import type { CanvasPalette } from './hooks/useCanvasEnrichedNodes';
import { ColorModeContext } from '../../contexts/color-mode';
import { PageContainer } from '@shared/PageHeader';
import { usePermission } from '../../auth/usePermission';
import { BRAND, LIVE } from '../../theme';

const nodeTypes = {
  connectorNode: ConnectorNode,
  condition: ConditionNode,
  action: ActionNode,
};

/** Fit the graph beside the policy node rail (NodePalette, 232px wide, top-left). */
const FIT_VIEW_OPTIONS = { padding: { top: 0.2, right: 0.2, bottom: 0.2, left: '272px' as const } };

export const BlueprintCanvas = () => {
  const { token } = theme.useToken();
  const { mode } = useContext(ColorModeContext);
  const navigate = useNavigate();
  const reactFlowRef = useRef<{
    screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number };
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [api, contextHolder] = notification.useNotification();
  const [configVisible, setConfigVisible] = useState(false);
  const [connectorHealth, setConnectorHealth] = useState<Record<string, HealthStatus>>({});

  const nodeMgmt = useCanvasNodeManagement({
    api,
    reactFlowRef,
    canvasRef,
    onConnectorDeleted: (nodeId) => {
      setConnectorHealth((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
    },
  });

  const { nodes, setNodes, edges, setEdges } = nodeMgmt;
  const loadSave = useCanvasLoadAndSave({ setNodes, setEdges, nodes, edges, api });
  const { simulationVisible, setSimulationVisible, testUsers, totalUsers, handleSyncComplete } =
    useCanvasSimulation();
  const deploy = useCanvasDeploy(api);
  const canEdit = usePermission('policy-admin');
  const {
    validate,
    isDirty: isPolicyDirty,
    updateNode: updateDraftNode,
    removeNode: removeDraftNode,
  } = usePolicyDraftStore();

  const pipelineCount = testUsers.length;
  // Each source node shows its own users, not the hub total.
  const sourceCounts = useMemo(
    () => countUsersPerSource(nodes, testUsers, totalUsers),
    [nodes, testUsers, totalUsers],
  );
  const activeConnectors = detectActiveConnectors(nodes);

  const { data: pipelineStatusData } = useQuery({
    queryKey: ['blueprints', 'pipeline-status'],
    queryFn: async () => {
      const { data } = await axiosInstance.get<{ status?: string; config?: PipelineConfig }>(
        `${API_BASE}/blueprints/pipeline-status`,
      );
      return data;
    },
    refetchInterval: POLL_INTERVALS.PIPELINE_MS,
    refetchIntervalInBackground: false,
  });
  const pipelineStatus = pipelineStatusData?.status ?? 'DRAFT';
  const pipelineConfig: PipelineConfig | undefined = pipelineStatusData?.config;
  const isLive = pipelineStatus === 'DEPLOYED';

  const palette = useMemo<CanvasPalette>(
    () => ({
      surface: token.colorBgContainer,
      border: token.colorBorder,
      text: token.colorText,
      textSecondary: token.colorTextSecondary,
      primary: token.colorPrimary,
      primaryBg: token.colorPrimaryBg,
      edge: BRAND.edgeStroke,
      shadow: token.boxShadow,
    }),
    [token],
  );

  const { allNodes, allEdges } = useCanvasEnrichedNodes({
    nodes,
    edges,
    sourceCounts,
    connectorHealth,
    draftNodes: nodeMgmt.draftNodes,
    draftEdges: nodeMgmt.draftEdges,
    draftNodeSizes: nodeMgmt.draftNodeSizes,
    colorPrimary: token.colorPrimary,
    palette,
    live: isLive,
  });

  useEffect(() => {
    const controller = new AbortController();
    const targetNodes = nodes.filter((n) => n.data?.role === 'target');
    const checkHealth = async () => {
      for (const node of targetNodes) {
        if (controller.signal.aborted) return;
        const nodeId = node.id;
        if (connectorHealth[nodeId] === 'online' || connectorHealth[nodeId] === 'offline') continue;
        setConnectorHealth((prev) => ({ ...prev, [nodeId]: 'checking' }));
        try {
          const { data } = await axiosInstance.get(`${API_BASE}/blueprints/health/${nodeId}`, {
            signal: controller.signal,
          });
          setConnectorHealth((prev) => ({
            ...prev,
            [nodeId]: data.status === 'online' ? 'online' : 'offline',
          }));
        } catch {
          if (controller.signal.aborted) return;
          setConnectorHealth((prev) => ({ ...prev, [nodeId]: 'offline' }));
        }
      }
    };
    checkHealth();
    return () => controller.abort();
  }, [nodes.length]);

  useEffect(() => {
    const timer = setTimeout(() => validate(), POLL_INTERVALS.VALIDATION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [nodeMgmt.draftNodes, nodeMgmt.draftEdges, validate]);

  if (loadSave.isLoading) {
    return (
      <PageContainer fill>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: token.colorBgLayout,
          }}
          aria-busy
          aria-label="Loading Design studio"
        >
          <Space direction="vertical" align="center" size={12}>
            <Spin />
            <Typography.Text strong>Loading Design studio</Typography.Text>
            <Typography.Text type="secondary">
              Fetching your saved pipeline and connector health
            </Typography.Text>
          </Space>
        </div>
      </PageContainer>
    );
  }

  // A canvas that failed to load is not shown, and nothing offers Save over the stored one
  if (loadSave.loadError) {
    return (
      <PageContainer fill>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            background: token.colorBgLayout,
          }}
        >
          <Alert
            type="error"
            showIcon
            style={{ width: '100%', maxWidth: 640 }}
            message="The saved Design studio canvas could not be loaded"
            description={
              <Space direction="vertical" size={12}>
                <Typography.Text>{loadSave.loadError}</Typography.Text>
                <Button type="primary" onClick={loadSave.retryLoad}>
                  Retry
                </Button>
              </Space>
            }
          />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer fill>
      {contextHolder}
      <CanvasToolbar
        canEdit={canEdit}
        isPolicyDirty={isPolicyDirty}
        pipelineStatus={pipelineStatus}
        isSaving={loadSave.isSaving}
        onSave={loadSave.handleSaveCanvas}
        onSimulate={() => setSimulationVisible(true)}
        onDeploy={deploy.handleDeploy}
        onPause={deploy.handlePause}
        onResume={deploy.handleResume}
        onStop={deploy.handleStop}
        addConnectorItems={nodeMgmt.addConnectorItems}
      />
      {deploy.circuitBreakerAlert && (
        <Alert
          type="error"
          showIcon
          message={
            <Space>
              <span>
                Pipeline auto-paused: Error rate {deploy.circuitBreakerAlert.errorRate.toFixed(1)}%
                exceeded {deploy.circuitBreakerAlert.threshold}% threshold.
              </span>
              <Button size="small" onClick={() => navigate('/audit')}>
                View Errors
              </Button>
              <Button size="small" type="primary" onClick={deploy.handleResume}>
                Resume Pipeline
              </Button>
            </Space>
          }
          closable
          onClose={() => deploy.setCircuitBreakerAlert(null)}
          banner
        />
      )}
      <div
        ref={canvasRef}
        style={{ flex: 1, position: 'relative', minHeight: 0 }}
        role="application"
        aria-label="Policy builder canvas. Press Tab to navigate nodes, Delete to remove selected node."
        tabIndex={0}
      >
        <ReactFlow
          nodes={allNodes}
          edges={allEdges}
          nodeTypes={nodeTypes}
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
            instance.fitView(FIT_VIEW_OPTIONS);
          }}
          onNodesChange={nodeMgmt.onNodesChange}
          onEdgesChange={nodeMgmt.onEdgesChange}
          onConnect={nodeMgmt.onConnect}
          onDrop={nodeMgmt.onDrop}
          onDragOver={nodeMgmt.onDragOver}
          onNodeClick={(_: React.MouseEvent, node: Node) => {
            nodeMgmt.setSelectedNode(node);
            setConfigVisible(true);
          }}
          onEdgeClick={nodeMgmt.onEdgeClick}
          onPaneClick={() => nodeMgmt.setSelectedNode(null)}
          nodesConnectable
        >
          <Background
            variant={BackgroundVariant.Dots}
            color={token.colorBorder}
            bgColor={token.colorBgLayout}
            gap={18}
            size={1.5}
          />
          <Panel position="top-left">
            <NodePalette onAdd={nodeMgmt.addPolicyNodeAtCenter} />
          </Panel>
          <Controls showInteractive={false} fitViewOptions={FIT_VIEW_OPTIONS} />
          <MiniMap
            pannable
            zoomable
            ariaLabel="Canvas overview"
            style={{ width: 160, height: 104 }}
            bgColor={token.colorBgContainer}
            maskColor={token.colorFillTertiary}
            nodeColor={(n) =>
              n.data?.role === 'brain'
                ? isLive
                  ? LIVE.color
                  : token.colorPrimary
                : token.colorTextQuaternary
            }
            nodeStrokeWidth={0}
            nodeBorderRadius={3}
          />
        </ReactFlow>
      </div>
      <CanvasDrawers
        configVisible={configVisible}
        onCloseConfig={() => setConfigVisible(false)}
        simulationVisible={simulationVisible}
        onCloseSimulation={() => setSimulationVisible(false)}
        deployModalVisible={deploy.deployModalVisible}
        onCloseDeployModal={() => deploy.setDeployModalVisible(false)}
        onDeployed={deploy.onDeployed}
        selectedNode={nodeMgmt.selectedNode}
        edgePopover={nodeMgmt.edgePopover}
        onCloseEdgePopover={() => nodeMgmt.setEdgePopover(null)}
        onDeleteConnector={nodeMgmt.handleDeleteConnector}
        onUpdateNodeDataAndSave={loadSave.handleUpdateNodeDataAndSave}
        onUpdatePolicyNode={(id, data) => updateDraftNode(id, { data })}
        onRemovePolicyNode={removeDraftNode}
        activeConnectors={activeConnectors}
        activeConnectorsForMastery={deriveActiveConnectorsForMastery(nodes)}
        otherPrimarySources={otherPrimarySources(nodes, nodeMgmt.selectedNode?.id)}
        brainConfig={loadSave.brainConfigForDrawer}
        onCorrelationSave={loadSave.handleCorrelationSave}
        pipelineCount={pipelineCount}
        testUsers={testUsers}
        onOpenSimulation={() => {
          setConfigVisible(false);
          setSimulationVisible(true);
        }}
        onSyncComplete={handleSyncComplete}
        pipelineConfig={pipelineConfig}
        onEdgeConditionSave={nodeMgmt.handleEdgeConditionSave}
      />
    </PageContainer>
  );
};
