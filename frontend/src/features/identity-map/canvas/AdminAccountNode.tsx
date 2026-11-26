/**
 * AdminAccountNode — linked admin account node.
 * Displays: admin tier badge (T0/T1/T2), session status, identity reference.
 */

import React from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { Space, Tag, Typography, theme } from 'antd';
import { CrownOutlined } from '@ant-design/icons';
import { SEMANTIC } from '@theme/themeConfig';

const { Text } = Typography;

export interface AdminAccountNodeData {
  identityId: string;
  adminTier: string;
  status: string;
  activatedAt?: string;
  [key: string]: unknown;
}

const TIER_COLORS: Record<string, string> = {
  TIER_0: SEMANTIC.statusError,
  TIER_1: SEMANTIC.statusDrift,
  TIER_2: SEMANTIC.statusRunning,
};

/** Tag fills carry small white text, so the warning tier uses its AA text shade. */
const TIER_TAG_COLORS: Record<string, string> = {
  ...TIER_COLORS,
  TIER_1: SEMANTIC.statusDriftText,
};

const TIER_LABELS: Record<string, string> = {
  TIER_0: 'T0',
  TIER_1: 'T1',
  TIER_2: 'T2',
};

export const AdminAccountNode: React.FC<NodeProps> = ({ data }) => {
  const { token } = theme.useToken();
  const { identityId, adminTier, status } = data as unknown as AdminAccountNodeData;

  const tierColor = TIER_COLORS[adminTier] ?? token.colorPrimary;
  const tierLabel = TIER_LABELS[adminTier] ?? adminTier;
  const isActive = status === 'active';

  return (
    <div
      style={{
        padding: 10,
        borderRadius: 8,
        background: token.colorBgContainer,
        border: `1px dashed ${tierColor}`,
        minWidth: 150,
        textAlign: 'center',
      }}
      role="group"
      aria-label={`Admin account: ${tierLabel}`}
    >
      <Handle type="target" position={Position.Left} id="from-identity" />
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <CrownOutlined style={{ fontSize: 18, color: tierColor }} />
        <Tag color={TIER_TAG_COLORS[adminTier] ?? tierColor} style={{ margin: 0 }}>
          {tierLabel}
        </Tag>
        <Tag color={isActive ? SEMANTIC.statusSynced : SEMANTIC.statusInactive}>
          {isActive ? 'Active' : 'Inactive'}
        </Tag>
        <Text type="secondary" style={{ fontSize: 10 }} ellipsis={{ tooltip: identityId }}>
          {identityId.slice(0, 8)}...
        </Text>
      </Space>
    </div>
  );
};
