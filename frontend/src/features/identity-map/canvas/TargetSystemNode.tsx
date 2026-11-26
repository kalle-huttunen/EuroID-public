/**
 * TargetSystemNode — per-target-system node for the Identity Entitlement Map.
 * Displays: system name, sync status, entitlement count, drift badge.
 */

import React from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Space, Tag, Typography, Badge, theme } from 'antd';
import { CloudServerOutlined } from '@ant-design/icons';
import { SEMANTIC } from '@theme/themeConfig';
import { DriftBadge } from './DriftBadge';

const { Text } = Typography;

export type SyncStatus = 'SYNCED' | 'SYNCING' | 'ERROR' | 'DRIFT' | 'PENDING';

export interface TargetSystemNodeData {
  systemName: string;
  syncStatus: SyncStatus;
  entitlementCount: number;
  driftCount: number;
  onDriftClick?: () => void;
  [key: string]: unknown;
}

const STATUS_CONFIG: Record<SyncStatus, { color: string; label: string }> = {
  SYNCED: { color: SEMANTIC.statusSynced, label: 'Synced' },
  SYNCING: { color: SEMANTIC.statusRunning, label: 'Syncing' },
  ERROR: { color: SEMANTIC.statusError, label: 'Error' },
  DRIFT: { color: SEMANTIC.statusDriftText, label: 'Drift' },
  PENDING: { color: SEMANTIC.statusInactive, label: 'Pending' },
};

export const TargetSystemNode: React.FC<NodeProps> = ({ data }) => {
  const { token } = theme.useToken();
  const { systemName, syncStatus, entitlementCount, driftCount, onDriftClick } =
    data as unknown as TargetSystemNodeData;

  const statusConf = STATUS_CONFIG[syncStatus] ?? STATUS_CONFIG.PENDING;

  return (
    <div
      style={{
        padding: 12,
        borderRadius: 8,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorder}`,
        minWidth: 180,
        textAlign: 'center',
      }}
      role="group"
      aria-label={`Target system: ${systemName}`}
    >
      <Handle type="target" position={Position.Top} id="from-identity" />
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <CloudServerOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
        <Text strong style={{ fontSize: 13 }}>
          {systemName}
        </Text>
        <Space size={4}>
          <Tag color={statusConf.color} style={{ margin: 0 }}>
            {statusConf.label}
          </Tag>
          <Badge
            count={entitlementCount}
            showZero
            style={{ backgroundColor: token.colorPrimary }}
            size="small"
          />
        </Space>
        {driftCount > 0 && <DriftBadge count={driftCount} onClick={onDriftClick} />}
      </Space>
      <Handle type="source" position={Position.Bottom} id="to-entitlements" />
    </div>
  );
};
