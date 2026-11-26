/**
 * SimulationDrawer - Impact Fleet View for Mass Provisioning
 *
 * Two modes:
 * 1. Policy simulation: When simulationResult is provided, shows Recharts (pie, bar), affected users table, Confirm & Save
 * 2. Blueprint impact: Connector management, delta analysis, Entra metadata (legacy)
 */
import React, { useState, useEffect } from 'react';
import {
  Drawer,
  Alert,
  Space,
  Button,
  Typography,
  Divider,
  Spin,
  Tabs,
  Switch,
  Table,
  Tag,
  Modal,
  message,
  theme,
} from 'antd';
import {
  WarningOutlined,
  SafetyCertificateOutlined,
  ApiOutlined,
  PlayCircleOutlined,
  ExperimentOutlined,
  BarChartOutlined,
  UserOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { PieChart, Pie, Cell, Legend, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer } from 'recharts';
import { IStandardUser } from '../../interfaces';
import { API_BASE } from '@api/constants';
import { ConnectorManager } from './components/blueprint/ConnectorManager';
import { DeltaAnalysis, UserDelta } from './components/blueprint/DeltaAnalysis';
import { EntraIDMetadata, EntraUserMetadata } from './components/blueprint/EntraIDMetadata';
import type { SimulationResult } from '@stores/policy-draft-store';
import { usePolicyDraftStore } from '@stores/policy-draft-store';
import { draftToPolicy } from './utils/draft-to-policy';
import { axiosInstance } from '@api/data';

const { Text, Title } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
  testUsers: IStandardUser[];
  activeConnectors: string[];
  simulationResult?: SimulationResult | null;
}

export const SimulationDrawer: React.FC<Props> = ({
  open,
  onClose,
  testUsers,
  activeConnectors,
  simulationResult,
}) => {
  const { token } = theme.useToken();
  const PIE_COLORS = { gain: token.colorSuccess, lose: token.colorError, unchanged: token.colorBorder };

  const [dryRunMode, setDryRunMode] = useState(true);
  const [simulating, setSimulating] = useState(false);
  const [deltas, setDeltas] = useState<UserDelta[]>([]);
  const [entraMetadata, setEntraMetadata] = useState<EntraUserMetadata[]>([]);
  const [enabledConnectors, setEnabledConnectors] = useState<string[]>(activeConnectors);
  const [activeTab, setActiveTab] = useState('impact');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmSaveVisible, setConfirmSaveVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setEnabledConnectors(activeConnectors);
      if (simulationResult) setActiveTab('impact');
    }
  }, [open, activeConnectors, simulationResult]);

  const handleConnectorToggle = (connectorId: string, enabled: boolean) => {
    setEnabledConnectors((prev) =>
      enabled ? [...prev, connectorId] : prev.filter((id) => id !== connectorId)
    );
  };

  const handleConnectorDelete = (connectorId: string) => {
    setEnabledConnectors((prev) => prev.filter((id) => id !== connectorId));
  };

  const runImpactAnalysis = async () => {
    setSimulating(true);
    setErrorMessage(null);
    try {
      const { data } = await axiosInstance.post(`${API_BASE}/blueprints/impact-analysis`, {
        users: testUsers,
        connectors: enabledConnectors,
        dryRun: dryRunMode,
      });
      setDeltas(data.deltas || []);
      setEntraMetadata(data.entraMetadata || []);
      setActiveTab('delta');
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } }; message?: string })?.response
          ?.data?.message ??
        (err as { message?: string })?.message ??
        'Impact analysis failed.';
      setErrorMessage(msg);
    } finally {
      setSimulating(false);
    }
  };

  const handleConfirmSave = () => {
    setConfirmSaveVisible(true);
  };

  const performSave = async () => {
    setSaving(true);
    try {
      const { draftNodes, draftEdges, markClean } = usePolicyDraftStore.getState();
      const policy = draftToPolicy(draftNodes, draftEdges);

      await axiosInstance.post(`${API_BASE}/policy`, {
        ...policy,
        status: 'draft',
      });
      markClean();
      message.success('Policy saved');
      setConfirmSaveVisible(false);
      onClose();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        'Save failed';
      message.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const hasPolicyResult = !!simulationResult;
  const gain = simulationResult?.usersGainingAccess ?? simulationResult?.matchedCount ?? 0;
  const lose = simulationResult?.usersLosingAccess ?? 0;
  const unchanged = simulationResult?.usersUnchanged ?? 0;
  const totalAffected = simulationResult?.totalAffected ?? simulationResult?.matchedCount ?? 0;

  const pieData = [
    { name: 'Gaining Access', value: gain, color: PIE_COLORS.gain },
    { name: 'Losing Access', value: lose, color: PIE_COLORS.lose },
    { name: 'Unchanged', value: unchanged, color: PIE_COLORS.unchanged },
  ].filter((d) => d.value > 0);

  const barData = simulationResult?.actionsBySystem
    ? Object.entries(simulationResult.actionsBySystem).map(([name, count]) => ({ name, count }))
    : [];

  const affectedUsers = simulationResult?.affectedUsers ?? simulationResult?.matchedUsers ?? [];
  const tableColumns = [
    { title: 'Name', dataIndex: 'name', key: 'name' },
    {
      title: 'Changes',
      dataIndex: 'changes',
      key: 'changes',
      render: (changes: Array<{ type: string; entitlement: string; connector: string }>) =>
        changes?.length > 0 ? (
          <Space wrap>
            {changes.map((c, i) => (
              <Tag key={i} color={c.type === 'grant' ? 'green' : 'red'}>
                {c.type} {c.entitlement}
              </Tag>
            ))}
          </Space>
        ) : (
          <Tag color="blue">Access granted</Tag>
        ),
    },
  ];

  const hasEntraConnector = enabledConnectors.some(
    (c) => c.toLowerCase().includes('entra') || c.toLowerCase().includes('azure')
  );

  const policyTabItems = [
    {
      key: 'impact',
      label: (
        <Space>
          <BarChartOutlined />
          Impact Overview
        </Space>
      ),
      children: (
        <Space direction="vertical" style={{ width: '100%' }} size="large">
          {pieData.length > 0 && (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                Impact Distribution
              </Text>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}`}
                  >
                    {pieData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
          {barData.length > 0 && (
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                Impact by Connector
              </Text>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={barData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="count" fill={token.colorPrimary} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              Risk Assessment
            </Text>
            <Tag color={simulationResult?.riskScore === 0 ? 'green' : simulationResult?.riskScore && simulationResult.riskScore < 50 ? 'gold' : 'red'}>
              Risk: {simulationResult?.riskScore ?? 0}
            </Tag>
          </div>
        </Space>
      ),
    },
    {
      key: 'users',
      label: (
        <Space>
          <UserOutlined />
          Affected Users
        </Space>
      ),
      children: (
        <Table
          columns={tableColumns}
          dataSource={affectedUsers.map((u, i) => ({
            key: (u as { identityId?: string }).identityId ?? i,
            name: (u as { name?: string }).name ?? `${(u as Record<string, unknown>).firstName} ${(u as Record<string, unknown>).lastName}`,
            changes: (u as { changes?: unknown[] }).changes,
          }))}
          size="small"
          virtual={affectedUsers.length > 100}
          scroll={affectedUsers.length > 100 ? { y: 400 } : undefined}
          pagination={affectedUsers.length > 100 ? false : affectedUsers.length > 50 ? { pageSize: 50 } : false}
        />
      ),
    },
  ];

  const blueprintTabItems = [
    {
      key: 'connectors',
      label: (
        <Space>
          <ApiOutlined />
          Connector Management
        </Space>
      ),
      children: (
        <ConnectorManager
          connectors={activeConnectors}
          onConnectorToggle={handleConnectorToggle}
          onConnectorDelete={handleConnectorDelete}
          onRefreshHealth={() => {}}
        />
      ),
    },
    {
      key: 'delta',
      label: (
        <Space>
          <WarningOutlined />
          Delta Analysis
        </Space>
      ),
      children:
        deltas.length > 0 ? (
          <DeltaAnalysis deltas={deltas} loading={simulating} />
        ) : (
          <Alert
            message="No Analysis Available"
            description="Run the impact analysis to see what will change across your target systems."
            type="info"
            showIcon
          />
        ),
    },
    ...(hasEntraConnector
      ? [
          {
            key: 'entra',
            label: (
              <Space>
                <SafetyCertificateOutlined />
                Entra ID Metadata
              </Space>
            ),
            children:
              entraMetadata.length > 0 ? (
                <EntraIDMetadata users={entraMetadata} loading={simulating} />
              ) : (
                <Alert
                  message="No Entra ID Data"
                  description="Run the analysis to see license assignments, group memberships, and UPN validation."
                  type="info"
                  showIcon
                />
              ),
          },
        ]
      : []),
  ];

  return (
    <>
      <Drawer
        title={
          <Space>
            <ExperimentOutlined />
            <Title level={4} style={{ margin: 0 }}>
              {hasPolicyResult ? 'Policy Simulation Results' : 'Impact Fleet Analysis'}
            </Title>
          </Space>
        }
        placement="right"
        width={900}
        onClose={onClose}
        open={open}
        aria-label={hasPolicyResult ? 'Simulation results' : 'Impact Fleet Analysis'}
        styles={{ header: { background: token.colorPrimaryBg } }}
        extra={
          <Space>
            {hasPolicyResult ? (
              <>
                <Button onClick={onClose}>Close</Button>
                <Button
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  onClick={handleConfirmSave}
                  disabled={!simulationResult}
                  aria-label="Confirm policy changes and save"
                >
                  Confirm & Save
                </Button>
              </>
            ) : (
              <>
                <Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Dry Run Mode
                  </Text>
                  <Switch
                    checked={dryRunMode}
                    onChange={setDryRunMode}
                    checkedChildren="Safe"
                    unCheckedChildren="Live"
                  />
                </Space>
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={runImpactAnalysis}
                  loading={simulating}
                  disabled={enabledConnectors.length === 0}
                >
                  {dryRunMode ? 'Run Dry Run' : 'Run Live Analysis'}
                </Button>
              </>
            )}
          </Space>
        }
      >
        {simulating ? (
          <div style={{ textAlign: 'center', marginTop: 50 }}>
            <Spin
              size="large"
              tip={dryRunMode ? 'Simulating impact (safe mode)...' : 'Analyzing live systems...'}
            >
              <div style={{ minHeight: 120 }} />
            </Spin>
          </div>
        ) : (
          <>
            {hasPolicyResult && !dryRunMode && (
              <Alert
                message="⚠️ LIVE MODE ACTIVE"
                description="You are running in LIVE mode. Changes may be written to target systems if you proceed with provisioning."
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                closable
              />
            )}

            {!hasPolicyResult && enabledConnectors.length === 0 && (
              <Alert
                message="No Connectors Enabled"
                description="Enable at least one connector in the Connector Management tab to run impact analysis."
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
              />
            )}

            {errorMessage && (
              <Alert
                message="Analysis failed"
                description={errorMessage}
                type="error"
                showIcon
                style={{ marginBottom: 16 }}
                closable
                onClose={() => setErrorMessage(null)}
              />
            )}

            {hasPolicyResult ? (
              <Tabs activeKey={activeTab} onChange={setActiveTab} items={policyTabItems} />
            ) : (
              <Tabs activeKey={activeTab} onChange={setActiveTab} items={blueprintTabItems} />
            )}
          </>
        )}
      </Drawer>

      <Modal
        title="Confirm & Save Policy"
        open={confirmSaveVisible}
        onCancel={() => setConfirmSaveVisible(false)}
        onOk={performSave}
        confirmLoading={saving}
        okText="Save"
      >
        <p>
          This will affect {totalAffected} users. Proceed?
        </p>
      </Modal>
    </>
  );
};
