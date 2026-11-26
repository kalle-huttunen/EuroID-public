/**
 * ConfigDrawer -- Four modes:
 *   1. Brain     -- delegates to BrainConfig (field mapping, policy engine, etc.)
 *   2. Source    -- pipeline preview (user count + sample table) + connection settings
 *   3. Connector -- simple connection settings + remove button
 *   4. Condition/Action -- policy node config (field/operator/value or targetSystem/actionType)
 */

import React, { useState } from 'react';
import { Drawer, Form, Button, Space, Input, Typography, theme, App } from 'antd';
import {
  RobotOutlined,
  ApiOutlined,
  DatabaseOutlined,
  FilterOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { ConnectorConfigs } from './connectors';
import { BrainConfig } from './brain-config';
import { parseConnectorNameFromNodeId, getConnectorByName, CONNECTOR_REGISTRY } from './shared';
import { useConnectorStore } from '@stores/connector-store';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { ConditionConfig } from './components/ConditionConfig';
import { ActionConfig } from './components/ActionConfig';
import { SourceConfig } from './components/SourceConfig';
import { ConnectorConfig } from './components/ConnectorConfig';
import { ErrorState } from '@shared/ErrorState';
import { apiErrorMessage } from '../dead-letter/dead-letter-labels';
import type { Node } from '@xyflow/react';
import type { CorrelationConfigFormValues } from './brain-config/IdentityCorrelationTab';
import type { IStandardUser } from '../../interfaces';
import { usePermission } from '../../auth/usePermission';

const { Text } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
  selectedNode: Node | null;
  onDeleteConnector: (nodeId: string) => void;
  onUpdateNodeDataAndSave?: (nodeId: string, data: Record<string, unknown>) => Promise<void>;
  onUpdatePolicyNode?: (nodeId: string, data: Record<string, unknown>) => void;
  onRemovePolicyNode?: (nodeId: string) => void;
  activeConnectors: string[];
  activeConnectorsForMastery: { name: string; type: 'source' | 'target'; label: string }[];
  /** The other HR source nodes whose saved contract tag is PRIMARY. */
  otherPrimarySources?: string[];
  brainConfig: CorrelationConfigFormValues | null;
  onCorrelationSave: (values: CorrelationConfigFormValues) => Promise<void>;
  pipelineCount?: number;
  testUsers?: IStandardUser[];
  onOpenSimulation?: () => void;
  onSyncComplete?: () => void;
}

export const ConfigDrawer: React.FC<Props> = ({
  open,
  onClose,
  selectedNode,
  onDeleteConnector,
  onUpdateNodeDataAndSave,
  onUpdatePolicyNode,
  onRemovePolicyNode,
  activeConnectors,
  activeConnectorsForMastery,
  otherPrimarySources = [],
  brainConfig,
  onCorrelationSave,
  pipelineCount = 0,
  testUsers = [],
  onOpenSimulation,
  onSyncComplete,
}) => {
  const [form] = Form.useForm();
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const { getConfig, updateConfig, syncFromBackend, syncError } = useConnectorStore();
  const [syncLoading, setSyncLoading] = useState(false);
  // The canvas node is saved by POST /blueprints/save (policy-admin), as the toolbar's Save; the
  // connector's own settings by PATCH /connectors/:name (connector-admin, super-admin)
  const canEditCanvas = usePermission('policy-admin');
  const canEditConnector = usePermission('connector-admin');
  const [lastSyncCount, setLastSyncCount] = useState<number | null>(null);

  const isBrain = selectedNode?.id === 'euroid-core';
  const isSource = selectedNode?.data?.role === 'source';
  const isCondition = selectedNode?.type === 'condition';
  const isAction = selectedNode?.type === 'action';

  const systemType =
    isBrain || isSource ? '' : parseConnectorNameFromNodeId(selectedNode?.id || '');
  const config = ConnectorConfigs[systemType];

  const sourceConnectorId = React.useMemo(() => {
    if (!isSource || !selectedNode?.id) return '';
    const meta = CONNECTOR_REGISTRY.find((c) =>
      c.idPatterns.some((p) => selectedNode.id.toLowerCase().includes(p.toLowerCase())),
    );
    return meta?.id ?? '';
  }, [isSource, selectedNode?.id]);

  React.useEffect(() => {
    if (open) {
      setLastSyncCount(null);
      setSyncLoading(false);
    }
  }, [open, selectedNode?.id]);

  const handleSyncNow = async () => {
    if (!sourceConnectorId) {
      message.warning('No backend connector ID found for this source.');
      return;
    }
    setSyncLoading(true);
    try {
      const { data } = await axiosInstance.post(
        `${API_BASE}/connectors/${sourceConnectorId}/ingest`,
      );
      const count = data?.ingested ?? data?.count ?? 0;
      setLastSyncCount(count);
      message.success(`Synced ${count} user${count !== 1 ? 's' : ''} from ${sourceConnectorId}`);
      onSyncComplete?.();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      message.error(e?.response?.data?.error ?? e?.message ?? 'Sync failed');
    } finally {
      setSyncLoading(false);
    }
  };

  /** The saved connector config (GET /connectors) under the node's own; while that fails the drawer shows the error (syncError), not the form. */
  const loadConnectorForm = React.useCallback(() => {
    syncFromBackend().then(() => {
      const nodeConfig = (selectedNode?.data?.config ?? {}) as Record<string, unknown>;
      const connectorId = getConnectorByName(systemType)?.id ?? systemType;
      const savedConnectorConfig = systemType ? getConfig(connectorId)?.config : undefined;
      const merged = { ...savedConnectorConfig, ...nodeConfig };
      if (Object.keys(merged).length > 0) form.setFieldsValue(merged);
      else form.resetFields();
    });
  }, [selectedNode, systemType, form, getConfig, syncFromBackend]);

  React.useEffect(() => {
    if (!open) return;
    if (isCondition) {
      form.setFieldsValue({
        field: selectedNode?.data?.field || 'department',
        operator: selectedNode?.data?.operator || 'equals',
        value: selectedNode?.data?.value || '',
      });
      return;
    }
    if (isAction) {
      form.setFieldsValue({
        targetSystem: selectedNode?.data?.targetSystem || 'entra-id',
        actionType: selectedNode?.data?.actionType || 'assign_group',
      });
      return;
    }
    if (isBrain || isSource) {
      if (selectedNode?.data?.config) {
        const cfg = selectedNode.data.config as Record<string, unknown>;
        form.setFieldsValue({
          ...cfg,
          ingestPriority: cfg.ingestPriority ?? 1,
          contractTag: cfg.contractTag ?? 'PRIMARY',
          masteryFields: cfg.masteryFields ?? [],
        });
      } else {
        form.resetFields();
        form.setFieldsValue({ ingestPriority: 1, contractTag: 'PRIMARY', masteryFields: [] });
        if (isSource && sourceConnectorId) {
          // Never saved from this drawer: start from the installed connector's settings
          // (GET /connectors), as a target's form does (loadConnectorForm).
          let current = true;
          syncFromBackend().then(() => {
            const installed = getConfig(sourceConnectorId)?.config;
            if (current && installed) form.setFieldsValue(installed);
          });
          return () => {
            current = false;
          };
        }
      }
      return;
    }
    loadConnectorForm();
  }, [
    open,
    selectedNode,
    form,
    isBrain,
    isSource,
    isCondition,
    isAction,
    loadConnectorForm,
    sourceConnectorId,
    syncFromBackend,
    getConfig,
  ]);

  const handleSave = async (values: Record<string, unknown>) => {
    if (isBrain || !canEditCanvas) return;
    if ((isCondition || isAction) && onUpdatePolicyNode && selectedNode?.id) {
      onUpdatePolicyNode(selectedNode.id, { ...selectedNode.data, ...values });
      onClose();
      return;
    }
    if (onUpdateNodeDataAndSave && selectedNode?.id) {
      const priorityKeys = ['ingestPriority', 'contractTag', 'masteryFields'];
      // A source's Priority & Mastery section sets these without form items, and onFinish
      // passes registered fields only: read them from the form store
      const config = isSource ? { ...values, ...form.getFieldsValue(priorityKeys) } : values;
      const connectionOnly = { ...values };
      priorityKeys.forEach((k) => delete connectionOnly[k]);
      const sysType = parseConnectorNameFromNodeId(selectedNode.id);
      const connectorId = getConnectorByName(sysType)?.id;
      // The connector first: settings its API refuses (400, 403) never reach the canvas node,
      // and the drawer stays open with the form for the admin to correct. A connector that is
      // not installed (404) has no settings of its own; ingest falls back to the canvas config
      // (HrIngestionService.getBlueprintConnectorConfig), so the canvas is written as before.
      // Without connector-admin the connection settings are read-only and only the node saves.
      if (canEditConnector && connectorId && sysType && Object.keys(connectionOnly).length > 0) {
        try {
          await updateConfig(connectorId, connectionOnly as Record<string, string>);
        } catch (err: unknown) {
          message.error(apiErrorMessage(err, 'Could not save the connector settings'));
          if ((err as { response?: { status?: number } })?.response?.status !== 404) return;
        }
      }
      await onUpdateNodeDataAndSave(selectedNode.id, { ...selectedNode.data, config });
    }
  };

  const titleIcon = isBrain ? (
    <RobotOutlined />
  ) : isSource ? (
    <DatabaseOutlined />
  ) : isCondition ? (
    <FilterOutlined />
  ) : isAction ? (
    <ThunderboltOutlined />
  ) : (
    <ApiOutlined />
  );
  const titleLabel = isCondition
    ? 'Condition'
    : isAction
      ? 'Action'
      : (selectedNode?.data?.label as string) || 'Configuration';

  return (
    <Drawer
      title={
        <Space>
          {titleIcon}
          <Text strong>{titleLabel}</Text>
        </Space>
      }
      width={1000}
      onClose={onClose}
      open={open}
      aria-label="Node configuration"
      extra={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          {canEditCanvas && (
            <Button type="primary" onClick={() => form.submit()}>
              Save Config
            </Button>
          )}
        </Space>
      }
    >
      {isBrain ? (
        <>
          <Form form={form} style={{ display: 'none' }}>
            <Form.Item name="_" hidden>
              <Input />
            </Form.Item>
          </Form>
          <BrainConfig
            activeConnectors={activeConnectors}
            activeConnectorsForMastery={activeConnectorsForMastery}
            brainConfig={brainConfig}
            onCorrelationSave={onCorrelationSave}
          />
        </>
      ) : isSource ? (
        <SourceConfig
          selectedNode={selectedNode}
          form={form}
          onSave={handleSave}
          onDeleteConnector={onDeleteConnector}
          onClose={onClose}
          pipelineCount={pipelineCount}
          testUsers={testUsers}
          onOpenSimulation={onOpenSimulation}
          sourceConnectorId={sourceConnectorId}
          syncLoading={syncLoading}
          lastSyncCount={lastSyncCount}
          onSyncNow={handleSyncNow}
          otherPrimarySources={otherPrimarySources}
          readOnly={!canEditCanvas}
          connectionReadOnly={!canEditConnector}
        />
      ) : isCondition ? (
        <ConditionConfig
          selectedNode={selectedNode}
          form={form}
          onSave={handleSave}
          onRemove={canEditCanvas ? onRemovePolicyNode : undefined}
          onClose={onClose}
          readOnly={!canEditCanvas}
        />
      ) : isAction ? (
        <ActionConfig
          selectedNode={selectedNode}
          form={form}
          onSave={handleSave}
          onRemove={canEditCanvas ? onRemovePolicyNode : undefined}
          onClose={onClose}
          readOnly={!canEditCanvas}
        />
      ) : syncError ? (
        <ErrorState
          compact
          title="Could not load the saved connector settings"
          error={syncError}
          onRetry={loadConnectorForm}
        />
      ) : (
        <ConnectorConfig
          form={form}
          onSave={handleSave}
          connectorConfig={config}
          onDeleteConnector={onDeleteConnector}
          onClose={onClose}
          nodeId={selectedNode?.id ?? ''}
          connectorId={getConnectorByName(systemType)?.id}
          readOnly={!canEditCanvas}
          connectionReadOnly={!canEditConnector}
        />
      )}
    </Drawer>
  );
};
