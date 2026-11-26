/**
 * CanvasDrawers — ConfigDrawer, ImpactAnalysisModal, DeployModal, EdgeConditionPopover.
 * Extracted from BlueprintCanvas for separation of concerns.
 */
import React from 'react';
import { Node } from '@xyflow/react';
import { ConfigDrawer } from '../ConfigDrawer';
import { ImpactAnalysisModal } from '../ImpactAnalysisModal';
import { DeployModal } from '../DeployModal';
import { EdgeConditionPopover } from '../EdgeConditionPopover';
import type { EdgeFlowData } from '../types/edge-condition.types';
import type { PipelineConfig } from '../DeployModal';
import type { CorrelationConfigFormValues } from '../brain-config/IdentityCorrelationTab';
import type { IStandardUser } from '../../../interfaces';
import type { ActiveConnectorInfo } from '../canvas';

export interface CanvasDrawersProps {
  configVisible: boolean;
  onCloseConfig: () => void;
  simulationVisible: boolean;
  onCloseSimulation: () => void;
  deployModalVisible: boolean;
  onCloseDeployModal: () => void;
  onDeployed: () => void;
  selectedNode: Node | null;
  edgePopover: {
    edgeId: string;
    edgeData: EdgeFlowData;
    position: { x: number; y: number };
  } | null;
  onCloseEdgePopover: () => void;
  onDeleteConnector: (nodeId: string) => void;
  onUpdateNodeDataAndSave: (nodeId: string, data: Record<string, unknown>) => Promise<void>;
  onUpdatePolicyNode: (id: string, data: Record<string, unknown>) => void;
  onRemovePolicyNode: (id: string) => void;
  activeConnectors: string[];
  activeConnectorsForMastery: ActiveConnectorInfo[];
  /** Other HR source nodes tagged Primary (otherPrimarySources). */
  otherPrimarySources: string[];
  brainConfig: CorrelationConfigFormValues | null;
  onCorrelationSave: (values: CorrelationConfigFormValues) => Promise<void>;
  pipelineCount: number;
  testUsers: IStandardUser[];
  onOpenSimulation: () => void;
  onSyncComplete: () => void;
  pipelineConfig?: PipelineConfig;
  onEdgeConditionSave: (edgeId: string, data: EdgeFlowData) => void;
}

export const CanvasDrawers: React.FC<CanvasDrawersProps> = ({
  configVisible,
  onCloseConfig,
  simulationVisible,
  onCloseSimulation,
  deployModalVisible,
  onCloseDeployModal,
  onDeployed,
  selectedNode,
  edgePopover,
  onCloseEdgePopover,
  onDeleteConnector,
  onUpdateNodeDataAndSave,
  onUpdatePolicyNode,
  onRemovePolicyNode,
  activeConnectors,
  activeConnectorsForMastery,
  otherPrimarySources,
  brainConfig,
  onCorrelationSave,
  pipelineCount,
  testUsers,
  onOpenSimulation,
  onSyncComplete,
  pipelineConfig,
  onEdgeConditionSave,
}) => (
  <>
    <ConfigDrawer
      open={configVisible}
      onClose={onCloseConfig}
      selectedNode={selectedNode}
      onDeleteConnector={onDeleteConnector}
      onUpdateNodeDataAndSave={onUpdateNodeDataAndSave}
      onUpdatePolicyNode={onUpdatePolicyNode}
      onRemovePolicyNode={onRemovePolicyNode}
      activeConnectors={activeConnectors}
      activeConnectorsForMastery={activeConnectorsForMastery}
      otherPrimarySources={otherPrimarySources}
      brainConfig={brainConfig}
      onCorrelationSave={onCorrelationSave}
      pipelineCount={pipelineCount}
      testUsers={testUsers}
      onOpenSimulation={onOpenSimulation}
      onSyncComplete={onSyncComplete}
    />
    <ImpactAnalysisModal
      open={simulationVisible}
      onClose={onCloseSimulation}
      testUsers={testUsers}
      activeConnectors={activeConnectors}
    />
    <DeployModal
      open={deployModalVisible}
      onClose={onCloseDeployModal}
      onDeployed={onDeployed}
      pipelineConfig={pipelineConfig}
    />
    {edgePopover && (
      <EdgeConditionPopover
        edgeId={edgePopover.edgeId}
        edgeData={edgePopover.edgeData}
        position={edgePopover.position}
        onSave={onEdgeConditionSave}
        onClose={onCloseEdgePopover}
        usersForCount={testUsers}
      />
    )}
  </>
);
